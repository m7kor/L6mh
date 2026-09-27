/**
 * Engine-level crossfade wiring test.
 *
 * The mixer itself is covered by crossfade.test.ts, and the @discordjs/voice
 * swap semantics by crossfade.integration.test.ts. This file covers the seam
 * between them: that `armCrossfade` records the outgoing tail *before* the blend
 * is due, and that `beginCrossfade`
 *   - re-subscribes a *new* player rather than swapping the resource,
 *   - tears the outgoing chain down so ffmpeg is not back-pressured,
 *   - promotes the incoming track to `session.current` with the right offset,
 *   - and falls back to a hard switch instead of wedging when no tail exists.
 *
 * Only the Discord voice connection is faked; the audio player, resource and
 * streams are the real thing. Timings are injected rather than waited out,
 * because the production values are minutes long.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAudioPlayer, NoSubscriberBehavior, VoiceConnectionStatus } from '@discordjs/voice';

process.env.NODE_ENV = 'test';

type Engine = typeof import('./engine.js');
let engine: Engine;
let sessionMod: typeof import('../session.js');

const BYTES_PER_SECOND = 192_000;

/** A stand-in for AudioStreamHandle, backed by real streams. */
function makeHandle(seconds = 10) {
  const pcm = new PassThrough({ highWaterMark: 1024 * 128 });
  const payload = Buffer.alloc(Math.floor(seconds * BYTES_PER_SECOND), 1);
  const sinks: PassThrough[] = [];
  // A live handle has already produced audio; `isPreloadUsable` rejects ones
  // that have not, so the fake must report a non-zero count from the start.
  const produced = payload.length;

  return {
    stream: pcm,
    get bytesProduced() { return produced; },
    get ended() { return false; },
    /** Mirrors PcmTap: a late-attached sink gets a copy from here on. */
    tap() {
      const s = new PassThrough({ highWaterMark: 1024 * 1024 });
      s.write(payload);
      sinks.push(s);
      return s;
    },

    untap(s: PassThrough) {
      const i = sinks.indexOf(s);
      if (i >= 0) sinks.splice(i, 1);
      try { s.destroy(); } catch { /* already gone */ }
    },
    kill() { try { pcm.destroy(); } catch { /* already gone */ } },
  };
}

function stubConnection() {
  const subscribed: unknown[] = [];
  return {
    subscribed,
    state: { status: VoiceConnectionStatus.Ready },
    joinConfig: { channelId: 'c1' },
    subscribe(player: unknown) { subscribed.push(player); return player; },
  };
}

before(async () => {
  sessionMod = await import('../session.js');
  engine = await import('./engine.js');
});

after(() => {
  sessionMod.sessions.clear();
});

const GUILD = 'test-guild-crossfade';

// A 2s track with a 1s blend: the tape starts almost immediately and the blend
// follows 1s later.
const TIMINGS = { fadeSeconds: 1, minTrackSeconds: 0.5, tapeMarginSeconds: 0.6 };

function freshSession() {
  sessionMod.sessions.delete(GUILD);
  const s: any = sessionMod.getSession(GUILD);
  s.continuous = true;
  s.manualStop = false;
  s.crossfading = false;
  s.mode = 'random';
  return s;
}

function armWithPreload(session: any, outgoing: any) {
  const conn = stubConnection();
  session.connection = conn;
  session.activeHandle = outgoing;
  session.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  session.current = { videoId: 'cur', url: 'u', title: 'current', durationSeconds: 4 };
  session.segmentStartOffset = 0;
  session.segmentStartedAt = Date.now();
  session.preloaded = {
    video: { videoId: 'next', url: 'u', title: 'next', durationSeconds: 100 },
    handle: makeHandle(20),
    createdAt: Date.now(),
  };
  return conn;
}

describe('engine: crossfade arming', () => {
  it('records the tail before the blend, then swaps to the incoming track', async () => {
    const session = freshSession();
    const outgoing = makeHandle(10);
    const conn = armWithPreload(session, outgoing);

    const { armCrossfade } = (engine as any).__test;
    armCrossfade(session, { id: GUILD }, { name: 'vc' }, session.current, outgoing, TIMINGS);

    // secondsLeft = 2, fadeSec = 1, tapeIn = 2 - 1.02 ≈ 0.98s
    assert.ok(session.tapeTimer, 'a tape timer was armed');
    assert.ok(session.crossfadeTimer, 'a blend timer was armed');
    assert.equal(session.outgoingTape, null, 'no tail before the timer fires');

    await new Promise((r) => setTimeout(r, 2_600));
    assert.ok(session.outgoingTape, 'the outgoing tail was recorded before the blend');

    await new Promise((r) => setTimeout(r, 1_000));

    assert.equal(conn.subscribed.length, 1, 'the connection was re-subscribed exactly once');
    assert.equal(
      conn.subscribed[0],
      session.player,
      'the newly subscribed player is the one now held by the session',
    );
    assert.equal(session.current?.videoId, 'next', 'the incoming track became current');
    assert.equal(session.segmentStartOffset, 1, 'progress is offset by the blend length');
    assert.equal(session.preloaded, null, 'the preload was consumed, not leaked');
    assert.ok(
      session.playedIds.has('next'),
      'the incoming track is recorded as played',
    );
  });

  it('releases the outgoing chain so ffmpeg is not back-pressured', async () => {
    const session = freshSession();
    const outgoing = makeHandle(10);
    armWithPreload(session, outgoing);

    const { armCrossfade } = (engine as any).__test;
    armCrossfade(session, { id: GUILD }, { name: 'vc' }, session.current, outgoing, TIMINGS);

    await new Promise((r) => setTimeout(r, 3_400));

    assert.equal(
      outgoing.stream.destroyed,
      true,
      'the outgoing PCM stream is torn down — an unread pipe would stall ffmpeg '
      + 'and starve the mixer',
    );
  });

  it('does not blend when the track is too short', async () => {
    const session = freshSession();
    const outgoing = makeHandle(10);
    const conn = armWithPreload(session, outgoing);
    session.current = { ...session.current, durationSeconds: 0.2 };

    const { armCrossfade } = (engine as any).__test;
    armCrossfade(session, { id: GUILD }, { name: 'vc' }, session.current, outgoing, TIMINGS);

    await new Promise((r) => setTimeout(r, 300));

    assert.equal(session.tapeTimer, null, 'no tape timer for a short track');
    assert.equal(session.crossfadeTimer, null, 'no blend timer for a short track');
    assert.equal(conn.subscribed.length, 0, 'the connection was left alone');
  });

  it('falls back to a hard switch when no tail was recorded', async () => {
    const session = freshSession();
    const conn = stubConnection();
    const outgoing = makeHandle(10);
    session.connection = conn;
    session.activeHandle = outgoing;
    session.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    session.current = { videoId: 'cur', url: 'u', title: 'current', durationSeconds: 100 };
    session.segmentStartOffset = 0;
    session.segmentStartedAt = Date.now();

    const { beginCrossfade } = (engine as any).__test;

    // No tape: the blend must not run, and must not leave the session wedged.
    await beginCrossfade({ id: GUILD }, { name: 'vc' }, 1);

    assert.equal(conn.subscribed.length, 0, 'no swap happened without a recorded tail');
    assert.equal(session.crossfading, false, 'the transition flag was not left set');
  });

  it('clearing the timers also prevents a stale blend', async () => {
    const session = freshSession();
    const outgoing = makeHandle(10);
    const conn = armWithPreload(session, outgoing);

    const { armCrossfade, clearCrossfadeTimers } = (engine as any).__test;
    armCrossfade(session, { id: GUILD }, { name: 'vc' }, session.current, outgoing, TIMINGS);
    assert.ok(session.crossfadeTimer, 'armed');

    clearCrossfadeTimers(session);
    assert.equal(session.crossfadeTimer, null);
    assert.equal(session.tapeTimer, null);

    await new Promise((r) => setTimeout(r, 3_400));

    assert.equal(conn.subscribed.length, 0, 'the cancelled blend never fired');
    assert.equal(session.outgoingTape, null, 'and never recorded a tail');
  });
});
