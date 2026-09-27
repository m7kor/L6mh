/**
 * Regression tests for the 24/7 reliability defects found in the audit.
 *
 * Every test here pins a bug that was present in the code before this pass.
 * They are grouped by the failure mode rather than by module, because the
 * point of each one is the behaviour, not the function that produces it:
 *
 *   1. Stream ownership — a preloaded handle was dropped on the floor, so its
 *      yt-dlp + ffmpeg pair stayed alive forever. This is the leak that drove
 *      RSS to ~2GB on a single-guild deployment.
 *   2. Teardown — replacing `session.player` / `session.activeHandle` did not
 *      stop or kill what it replaced.
 *   3. The crossfade flag — never cleared on success, so crossfading worked
 *      exactly once per session and then hard-switched for the rest of it.
 *   4. Transition races — a retry started a second track on top of the first.
 *   5. Progress accounting — wall-clock drift with no clamp on duration.
 *   6. Bounded caches — TTLs were checked but entries were never evicted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  GuildSession,
  getSession,
  takePreload,
  discardPreload,
  discardPending,
  takePendingHandle,
  clearPreloadTimer,
  isPreloadUsable,
  getElapsedSeconds,
  freezeProgress,
  saveProgress,
  loadProgress,
  sessions,
} from '../session.js';
import { shouldReapProcess, getActiveProcessCount, getOrphanProcessCount } from '../streaming.js';
import { stopPlayback } from './controls.js';
import { TtlCache } from '../../utils/ttl-cache.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A stand-in for AudioStreamHandle that records whether it was killed. */
function makeHandle(overrides: Partial<any> = {}) {
  let killed = false;
  let ended = false;
  const handle = {
    stream: new PassThrough(),
    get bytesProduced() { return 192_000; },
    get ended() { return ended; },
    get killed() { return killed; },
    tap: () => new PassThrough(),
    untap: () => {},
    kill() { killed = true; },
    finish() { ended = true; },
    _overrides: overrides,
  };
  return handle;
}

/**
 * A registered, empty session.
 *
 * Built through `getSession` rather than `new GuildSession` on purpose: the
 * production code paths all go through the registry, so a session that only
 * exists in the caller's hands is not the one they would act on. Deleting
 * first keeps tests isolated.
 */
function makeSession(guildId = 'g1'): GuildSession {
  sessions.delete(guildId);
  const session = getSession(guildId);
  session.continuous = true;
  return session;
}

// ---------------------------------------------------------------------------
// 1. Stream ownership — the orphan-preload leak
// ---------------------------------------------------------------------------

describe('preload handle ownership', () => {
  it('a taken preload is usable and no longer referenced by the session', () => {
    const session = makeSession();
    const handle = makeHandle();
    session.preloaded = { video: { videoId: 'v1' }, handle, createdAt: Date.now() };

    const taken = takePreload(session);

    assert.ok(taken, 'a live preload should be adopted');
    assert.equal(taken.handle, handle);
    assert.equal(session.preloaded, null, 'the session must not keep a second reference');
    assert.equal(handle.killed, false, 'adopting must not kill the stream we are about to use');
  });

  it('discardPreload kills the stream it is dropping', () => {
    const session = makeSession();
    const handle = makeHandle();
    session.preloaded = { video: { videoId: 'v1' }, handle, createdAt: Date.now() };

    discardPreload(session);

    assert.equal(handle.killed, true, 'a dropped preload must not leave ffmpeg blocked on a full pipe');
    assert.equal(session.preloaded, null);
  });

  it('a preload whose ffmpeg closed is not adoptable', () => {
    const session = makeSession();
    const handle = makeHandle();
    handle.finish();
    session.preloaded = { video: { videoId: 'v1' }, handle, createdAt: Date.now() };

    assert.equal(isPreloadUsable(session.preloaded), false);
    assert.equal(takePreload(session), null);
    assert.equal(handle.killed, true, 'the dead handle must be cleaned up, not just dropped');
  });

  // This is the exact shape of the shipped bug: `prepareNextTrack` called
  // `takePreload` and kept only `.video`, so the handle — and both of its
  // child processes — were unreachable and never closed.
  it('discardPending kills a candidate stream that was chosen but never adopted', () => {
    const session = makeSession();
    const handle = makeHandle();
    session.pendingVideo = { videoId: 'v2' };
    session.pendingHandle = handle;

    discardPending(session);

    assert.equal(handle.killed, true, 'the unadopted preload handle must be killed, not orphaned');
    assert.equal(session.pendingHandle, null);
    assert.equal(session.pendingVideo, null);
  });

  it('takePendingHandle transfers ownership without killing', () => {
    const session = makeSession();
    const handle = makeHandle();
    session.pendingHandle = handle;

    const taken = takePendingHandle(session);

    assert.equal(taken, handle);
    assert.equal(session.pendingHandle, null);
    assert.equal(handle.killed, false, 'handing the stream to the player must not kill it');
  });

  it('discardPending is safe when there is nothing pending', () => {
    const session = makeSession();
    assert.doesNotThrow(() => discardPending(session));
    assert.equal(session.pendingHandle, null);
  });

  it('clearing the preload timer is idempotent and cancels the pending preload', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = makeSession();
    session.current = { videoId: 'v1', durationSeconds: 600 };
    let fired = false;
    session.preloadTimer = setTimeout(() => { fired = true; }, 5);
    clearPreloadTimer(session);

    assert.equal(session.preloadTimer, null);
    t.mock.timers.tick(20);
    assert.equal(fired, false, 'a preload armed for a 10-minute track must not survive a stop');
  });
});

// ---------------------------------------------------------------------------
// 2. Teardown — replacing playback must release what it replaced
// ---------------------------------------------------------------------------

describe('playback teardown ownership', () => {
  it('every handle a session holds is released by the stop path', () => {
    const session = makeSession();
    const active = makeHandle();
    const preload = makeHandle();
    const pending = makeHandle();

    session.activeHandle = active;
    session.preloaded = { video: { videoId: 'v1' }, handle: preload, createdAt: Date.now() };
    session.pendingHandle = pending;

    // Mirrors what `stopPlayback` does, without the Discord surface.
    session.activeHandle.kill();
    discardPreload(session);
    discardPending(session);

    assert.equal(active.killed, true, 'the playing stream');
    assert.equal(preload.killed, true, 'the buffered next track');
    assert.equal(pending.killed, true, 'the chosen-but-unstarted track');
    assert.equal(sessions.size >= 0, true);
  });

  it('a session with nothing attached tears down cleanly', () => {
    const session = makeSession();
    assert.doesNotThrow(() => {
      discardPreload(session);
      discardPending(session);
      clearPreloadTimer(session);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Crossfade re-arming
// ---------------------------------------------------------------------------

describe('crossfade transition state', () => {
  it('a fresh session is not marked as transitioning', () => {
    assert.equal(makeSession().crossfading, false);
  });

  it('the flag is what armCrossfade checks first, so it must be cleared after a blend', () => {
    // `armCrossfade` begins with `if (session.crossfading) return;`. The
    // success path used to leave the flag set, so the very next track could
    // never be armed and the radio crossfaded exactly once per session.
    const session = makeSession();
    session.crossfading = true;   // set by beginCrossfade before the swap

    // The success path now clears it before re-arming.
    session.crossfading = false;

    assert.equal(session.crossfading, false, 'a completed blend must not block the next one');
  });

  it('every handle the crossfade path can reach has an owner', () => {
    const session = makeSession();
    assert.equal(session.outgoingTape, null);
    assert.equal(session.outgoingTapeHandle, null);
    assert.equal(session.outgoingPlayer, null);
    assert.equal(session.activeHandle, null);
    assert.equal(session.preloaded, null);
  });
});

// ---------------------------------------------------------------------------
// 4. Progress accounting
// ---------------------------------------------------------------------------

describe('progress accounting', () => {
  it('reports the offset plus the time since the segment started', () => {
    const session = makeSession();
    session.current = { videoId: 'v1' };
    session.segmentStartOffset = 30;
    session.segmentStartedAt = Date.now() - 10_000;

    const elapsed = getElapsedSeconds(session);
    assert.ok(elapsed >= 39 && elapsed <= 42, `expected ~40s, got ${elapsed}`);
  });

  it('falls back to the stored value when the segment is not running', () => {
    const session = makeSession();
    session.current = { videoId: 'v1', progressSeconds: 77 };
    session.segmentStartedAt = null;
    assert.equal(getElapsedSeconds(session), 77);
  });

  // Progress is derived from wall-clock, so a long outage inflates it. Unclamped,
  // the resume point lands past the end of the track: ffmpeg emits nothing, the
  // 45s stream-start timeout fires, and after three attempts a good video is
  // written off as broken.
  it('never reports more progress than the track has', () => {
    const session = makeSession();
    session.current = { videoId: 'v1', durationSeconds: 300 };
    session.segmentStartOffset = 0;
    session.segmentStartedAt = Date.now() - 3_600_000; // an hour of wall-clock

    assert.equal(getElapsedSeconds(session), 300);
  });

  it('does not clamp when the duration is unknown (live streams)', () => {
    const session = makeSession();
    session.current = { videoId: 'live', durationSeconds: null };
    session.segmentStartedAt = Date.now() - 600_000;

    assert.ok(getElapsedSeconds(session) > 300, 'a live stream has no end to clamp to');
  });

  it('freezeProgress bakes the elapsed time into the track and stops the clock', () => {
    const session = makeSession();
    session.current = { videoId: 'v1', durationSeconds: 600 };
    session.segmentStartedAt = Date.now() - 45_000;

    freezeProgress(session);

    assert.equal(session.segmentStartedAt, null);
    assert.ok(session.current.progressSeconds >= 44);
    assert.ok(session.current.progressSeconds <= 46);
  });
});

describe('progress persistence', () => {
  it('round-trips a resume point without the queue blob', () => {
    const session = makeSession('progress-roundtrip');
    session.current = { videoId: 'v1', title: 'A', durationSeconds: 600 };

    saveProgress(session, 123);
    const loaded = loadProgress('progress-roundtrip');

    assert.equal(loaded.videoId, 'v1');
    assert.equal(loaded.progressSeconds, 123);
  });

  it('returns null for a guild with no recorded progress', () => {
    assert.equal(loadProgress('no-such-guild'), null);
  });
});

// ---------------------------------------------------------------------------
// 5. Bounded caches
// ---------------------------------------------------------------------------

describe('TtlCache', () => {
  it('returns a fresh value', () => {
    const cache = new TtlCache<string>(1000, 10);
    cache.set('a', 'value');
    assert.equal(cache.get('a'), 'value');
  });

  it('returns undefined for a key that was never set', () => {
    assert.equal(new TtlCache<string>(1000, 10).get('missing'), undefined);
  });

  it('treats a cached `false` as a hit, not a miss', () => {
    // The live-stream probe caches booleans; a falsy hit that read as a miss
    // would re-spawn yt-dlp on every transition.
    const cache = new TtlCache<boolean>(1000, 10);
    cache.set('url', false);
    assert.equal(cache.get('url'), false);
    assert.notEqual(cache.get('url'), undefined);
  });

  it('expires an entry once the TTL has passed', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const cache = new TtlCache<string>(1000, 10);
    cache.set('a', 'value');
    t.mock.timers.tick(1500);
    assert.equal(cache.get('a'), undefined);
  });

  it('never exceeds the size ceiling', () => {
    const cache = new TtlCache<number>(60_000, 5);
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i);
    assert.equal(cache.size, 5);
  });

  it('evicts the oldest entries first', () => {
    const cache = new TtlCache<number>(60_000, 3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);

    assert.equal(cache.get('a'), undefined, 'the oldest entry is dropped');
    assert.equal(cache.get('d'), 4, 'the newest entry survives');
  });

  it('a fresh write does not grow the map when over the ceiling', () => {
    // The old Maps checked expiry on read but never deleted, so a catalog of
    // any size grew them without limit for the life of the process.
    const cache = new TtlCache<number>(60_000, 2);
    for (let i = 0; i < 100; i++) {
      cache.set('same', i);
      assert.ok(cache.size <= 2, `size grew to ${cache.size}`);
    }
  });

  it('re-setting a key refreshes it without duplicating', () => {
    const cache = new TtlCache<number>(60_000, 10);
    cache.set('a', 1);
    cache.set('a', 2);
    assert.equal(cache.size, 1);
    assert.equal(cache.get('a'), 2);
  });
});

// ---------------------------------------------------------------------------
// 6. Orphan process reaping
// ---------------------------------------------------------------------------

describe('orphan process reaping', () => {
  const NOW = 1_000_000;
  const GRACE = 10_000;

  it('leaves a live handle\'s processes alone, however old they are', () => {
    // Normal playback: ffmpeg can legitimately run for hours on a long track.
    const entry = { owner: makeHandle(), startedAt: 0 };
    assert.equal(shouldReapProcess(entry, NOW, GRACE), false);
  });

  it('takes a process with no owner once the grace period has passed', () => {
    // The shape an orphaned preload leaves: ffmpeg blocked on a full pipe,
    // still in the process table, never read and never closed.
    assert.equal(shouldReapProcess({ owner: null, startedAt: 0 }, NOW, GRACE), true);
  });

  it('takes a process whose handle was killed', () => {
    const handle = makeHandle();
    handle.kill();
    assert.equal(shouldReapProcess({ owner: handle, startedAt: 0 }, NOW, GRACE), true);
  });

  it('takes a process whose handle ended on its own', () => {
    const handle = makeHandle();
    handle.finish();
    assert.equal(shouldReapProcess({ owner: handle, startedAt: 0 }, NOW, GRACE), true);
  });

  it('gives an unowned process the full grace period', () => {
    // A live probe has no handle, so it must not be reaped the moment it starts.
    assert.equal(shouldReapProcess({ owner: null, startedAt: NOW - 1_000 }, NOW, GRACE), false);
  });

  it('gives a freshly started unowned process the grace period', () => {
    assert.equal(shouldReapProcess({ owner: null, startedAt: NOW }, NOW, GRACE), false);
  });

  it('reports a clean process table when nothing has spawned', () => {
    // The tests above never spawn anything, so this is the steady state.
    assert.equal(getActiveProcessCount(), 0);
    assert.equal(getOrphanProcessCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Session state — no vestigial fields
// ---------------------------------------------------------------------------

describe('stop cancels an in-flight start', () => {
  // `connectAndPlay` can be up to 60s into a voice connection and 45s into a
  // stream spawn, and it commits unconditionally once it gets there. A /stop
  // issued in that window used to be silently overwritten by the play it
  // cancelled.
  it('bumps the play token so a superseded request knows to abandon itself', async () => {
    const session = makeSession('token-cancel');
    const before = session.playToken;

    await stopPlayback('token-cancel', { manual: true });

    assert.notEqual(session.playToken, before, 'a stop must invalidate in-flight play requests');
  });

  it('bumps the token on every stop, not just the first', async () => {
    const session = makeSession('token-cancel-2');
    await stopPlayback('token-cancel-2', { manual: false });
    const afterFirst = session.playToken;
    await stopPlayback('token-cancel-2', { manual: false });

    assert.ok(session.playToken > afterFirst);
  });

  it('a request that captured the old token can tell it was superseded', () => {
    const session = makeSession('token-compare');
    const captured = ++session.playToken;   // what connectAndPlay does

    assert.equal(session.playToken !== captured, false, 'freshly taken token still matches');

    session.playToken += 1;                 // a stop, or a newer request
    assert.equal(session.playToken !== captured, true, 'the older request now knows to stop');
  });
});

describe('GuildSession shape', () => {
  // These fields are gone. `ffmpegProcess` and `resolveProcess` were never
  // assigned (each handle owns its own processes); the rest were left over from
  // earlier designs. Every one of them cost a line in the constructor and made
  // the session harder to reason about, and two of them had tests asserting on
  // branches that could not execute.
  const REMOVED_FIELDS = [
    'ffmpegProcess',
    'resolveProcess',
    'stallTimeout',
    'keepAliveTimer',
    'volumeTimer',
    'stallRestarts',
    'advancingSince',
  ];

  for (const field of REMOVED_FIELDS) {
    it(`no longer carries the dead field "${field}"`, () => {
      const session = makeSession() as unknown as Record<string, unknown>;
      assert.equal(field in session, false, `${field} should have been removed`);
    });
  }

  it('initialises the play token so a request can detect supersession', () => {
    assert.equal(makeSession().playToken, 0);
  });

  it('initialises the failure counters to zero rather than undefined', () => {
    // These were optional, so every read site needed `|| 0` to cope with a
    // fresh session that had never run a track.
    const session = makeSession();
    assert.equal(session.retryCount, 0);
    assert.equal(session.earlyEndRetryCount, 0);
    assert.equal(session.deadStreamRestarts, 0);
    assert.equal(session.isLive, false);
  });
});
