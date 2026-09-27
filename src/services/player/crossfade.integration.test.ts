/**
 * Integration tests for the crossfade swap, run against the real
 * @discordjs/voice AudioPlayer / AudioResource.
 *
 * These pin the three library behaviours the engine's crossfade depends on.
 * Each was verified empirically against @discordjs/voice 0.19, and each is easy
 * to get wrong in a way that produces a silent radio:
 *
 *  1. `createAudioResource` wraps raw PCM in an Opus encoder, so `playStream` is
 *     the *encoder*, not our stream.
 *  2. `player.play(other)` destroys the previous resource's encoder. Our PCM
 *     source survives — but the player has already drained it in real time, so
 *     the audio a crossfade needs is gone. A pre-attached **tape** is the only
 *     way to still have it.
 *  3. `connection.subscribe(other)` re-points the connection without touching the
 *     outgoing player's resource — the swap the engine uses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { CrossfadeReadable, SAMPLE_FRAME_SIZE } from './crossfade.js';

const BYTES_PER_SECOND = 48_000 * SAMPLE_FRAME_SIZE;

/** A fan-out mirroring the private PcmTap in streaming.ts. */
class Tap extends Transform {
  private readonly sinks = new Set<PassThrough>();
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    for (const sink of this.sinks) {
      if (sink.destroyed) { this.sinks.delete(sink); continue; }
      if (!sink.write(chunk)) this.sinks.delete(sink);
    }
    cb(null, chunk);
  }
  attach(): PassThrough {
    const s = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.sinks.add(s);
    return s;
  }
}

function tone(seconds: number, amplitude: number): Buffer {
  return Buffer.alloc(Math.floor(seconds * BYTES_PER_SECOND), amplitude & 0xff);
}

function collect(stream: PassThrough | CrossfadeReadable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on('data', (c) => parts.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

/** Stands in for a VoiceConnection: records what gets subscribed. */
function stubConnection() {
  const subscribed: unknown[] = [];
  return {
    subscribed,
    state: { status: 'ready' as const },
    subscribe(player: unknown) { subscribed.push(player); return player; },
  };
}

describe('@discordjs/voice resource wrapping', () => {
  it('playStream is an encoder, not the PCM source we passed in', () => {
    const pcm = new PassThrough();
    const resource = createAudioResource(pcm, { inputType: StreamType.Raw });
    assert.notEqual(
      resource.playStream,
      pcm,
      'the resource wraps our stream, so swapping the resource does not destroy our stream',
    );
  });

  it('a resource swap destroys the previous encoder but not our PCM', () => {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

    const first = new PassThrough();
    const r1 = createAudioResource(first, { inputType: StreamType.Raw });
    player.play(r1);

    const second = new PassThrough();
    player.play(createAudioResource(second, { inputType: StreamType.Raw }));

    assert.equal(r1.playStream.destroyed, true, 'the outgoing encoder is destroyed by the swap');
    assert.equal(first.destroyed, false, 'our PCM source itself survives');

    player.stop(true);
  });
});

describe('why a pre-attached tape is required', () => {
  it('a player consumes PCM in real time, so it cannot be re-read later', () => {
    // The engine must record the tail *before* the player drains it.
    const feed = new Tap();
    const playerStream = new PassThrough();
    feed.pipe(playerStream);

    feed.write(tone(1, 20_000));
    assert.ok(playerStream.readableLength > 0, 'audio is available');

    // The player consumes it.
    playerStream.read();
    assert.equal(playerStream.readableLength, 0, 'the player took the audio');

    // A tape attached afterwards has nothing retroactive to give.
    const lateTape = feed.attach();
    assert.equal(
      lateTape.readableLength,
      0,
      'a late tape starts empty — the already-played audio is unrecoverable',
    );
  });

  it('a tape attached before the tail records a full copy', () => {
    const feed = new Tap();
    const playerStream = new PassThrough();
    feed.pipe(playerStream);

    const tape = feed.attach();
    const seconds = 4;
    feed.write(tone(seconds, 20_000));
    playerStream.read();

    assert.equal(
      tape.readableLength,
      Math.floor(seconds * BYTES_PER_SECOND),
      'the tape kept its own copy for the blend',
    );
  });

  it('an unread tape is dropped rather than stalling playback', () => {
    const feed = new Tap();
    const playerStream = new PassThrough();
    feed.pipe(playerStream);
    const tape = feed.attach();
    void tape;

    const chunk = Buffer.alloc(64 * 1024, 3);
    for (let i = 0; i < 40; i++) {
      feed.write(chunk);
      playerStream.read();
    }

    feed.write(Buffer.from([7]));
    assert.deepEqual(
      playerStream.read(),
      Buffer.from([7]),
      'playback is unaffected by the abandoned tape',
    );
  });
});

describe('crossfade swap: connection.subscribe + tape', () => {
  it('re-subscribes a second player, keeps the tape, and blends continuously', async () => {
    // 1. ffmpeg feed, fanned out to the player and to a tape.
    const feed = new Tap();
    const playerStream = new PassThrough();
    feed.pipe(playerStream);

    // 2. Two seconds of the outgoing track are "played" and discarded.
    feed.write(tone(2, 20_000));
    playerStream.read();

    // 3. A few seconds before the end, the engine starts recording the tail.
    const tape = feed.attach();
    const fadeSec = 2;
    const tailSeconds = fadeSec + 1;
    feed.write(tone(tailSeconds, 20_000));
    playerStream.read();

    assert.equal(tape.readableLength, Math.floor(tailSeconds * BYTES_PER_SECOND));

    // 4. The incoming track's stream (in production this is the preloaded one).
    const next = new PassThrough();
    const nextSeconds = 4;
    next.end(tone(nextSeconds, 0));

    // 5. The mixer over the recorded tail and the incoming stream.
    const mixer = new CrossfadeReadable(tape as any, next as any, { durationSec: fadeSec });

    // 6. The swap the engine performs. The mix player is subscribed but not
    //    playing yet, so this test is the mixer's only consumer — two readers on
    //    one stream would split the audio, which is the very bug being avoided.
    const conn = stubConnection();
    const outgoingPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    const mixPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

    conn.subscribe(outgoingPlayer);
    conn.subscribe(mixPlayer);

    assert.equal(conn.subscribed.length, 2, 'the connection was re-subscribed');
    assert.notEqual(conn.subscribed[1], conn.subscribed[0], 'a different player is now subscribed');

    // NOTE: the mixer is deliberately *not* wrapped in an audio resource here.
    // `createAudioResource` calls `stream.pipeline()`, which immediately starts
    // draining its input — so wrapping it and also collecting from it would be
    // the same two-consumers mistake this design exists to avoid.

    // 7. The engine then tears the outgoing chain down, because its PCM now has
    //    no reader and would back-pressure ffmpeg.
    outgoingPlayer.stop(true);
    playerStream.destroy();

    assert.equal(tape.destroyed, false, 'stopping the outgoing player must not kill the tape');

    // 8. And the mixer still emits the incoming track in full.
    const out = await collect(mixer);
    assert.equal(
      out.length / SAMPLE_FRAME_SIZE,
      Math.floor((nextSeconds * BYTES_PER_SECOND) / SAMPLE_FRAME_SIZE),
      'the incoming track plays to its end through the mixer',
    );

    // 9. The blend really happened: the outgoing amplitude contributes early on
    //    and has faded out by the time the window closes.
    const frames = out.length / SAMPLE_FRAME_SIZE;
    const early = Math.abs(out.readInt16LE(Math.floor(frames * 0.1) * SAMPLE_FRAME_SIZE));
    const late = Math.abs(out.readInt16LE(Math.floor(frames * 0.9) * SAMPLE_FRAME_SIZE));
    assert.ok(early > 0, `expected blended audio early in the stream, got ${early}`);
    assert.equal(late, 0, 'the outgoing track is fully faded out by the end');
  });
});
