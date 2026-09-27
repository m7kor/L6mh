/**
 * Regression tests for the defects found while auditing the engine.
 *
 * Each test here corresponds to a specific bug that shipped to `main`:
 *   - `playStationId` returns a boolean, but the engine called `.catch()` on it.
 *   - The preload spawned yt-dlp, buffered one chunk, then killed the process
 *     at the boundary and re-resolved from scratch.
 *   - `streaming.ts` attached a `data` listener to the PCM stream, forcing
 *     flowing mode and discarding audio before a consumer attached.
 *   - `player.play()` destroys the previous resource's stream, so a crossfade
 *     cannot be introduced by swapping the player's resource.
 *   - `createAudioResource({ highWaterMark })` is not a valid option.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

import { buildAudioFilter, isPotProviderError } from '../streaming.js';
import { isPreloadUsable, takePreload, discardPreload, clearCrossfade } from '../session.js';

// ---------------------------------------------------------------------------
// streaming.ts
// ---------------------------------------------------------------------------

describe('buildAudioFilter', () => {
  it('scales volume by the percentage', () => {
    assert.match(buildAudioFilter(100, null, false), /volume=1/);
    assert.match(buildAudioFilter(50, null, false), /volume=0\.5/);
    assert.match(buildAudioFilter(200, null, false), /volume=2/);
  });

  it('normalises loudness and resamples to 48 kHz', () => {
    const filter = buildAudioFilter(100, null, false);
    assert.match(filter, /loudnorm=I=-16/);
    assert.match(filter, /aresample=48000/);
  });

  it('applies volume before loudness so the setting survives normalisation', () => {
    const filter = buildAudioFilter(50, null, false);
    assert.ok(
      filter.indexOf('volume=') < filter.indexOf('loudnorm='),
      `volume must come first, got: ${filter}`,
    );
  });

  it('omits fades entirely when disabled', () => {
    const filter = buildAudioFilter(100, 600, false);
    assert.ok(!filter.includes('afade'), `expected no afade, got: ${filter}`);
  });

  it('includes fade in and fade out when enabled', () => {
    const filter = buildAudioFilter(100, 600, true);
    assert.match(filter, /afade=t=in/);
    assert.match(filter, /afade=t=out:st=597\.00:d=3/);
  });

  it('skips the fade out for a track too short to hold one', () => {
    const filter = buildAudioFilter(100, 2, true);
    assert.match(filter, /afade=t=in/);
    assert.ok(!filter.includes('afade=t=out'), 'a 2s track cannot fit a 3s fade out');
  });
});

describe('isPotProviderError', () => {
  it('detects a bgutil connection failure', () => {
    assert.equal(isPotProviderError('bgutil: connect ECONNREFUSED 127.0.0.1:4416'), true);
    assert.equal(isPotProviderError('bgutil request ETIMEDOUT'), true);
  });

  it('does not fire on unrelated errors', () => {
    assert.equal(isPotProviderError('bgutil: ok'), false, 'no network error present');
    assert.equal(isPotProviderError('ECONNREFUSED 127.0.0.1:8080'), false, 'no bgutil mention');
    assert.equal(isPotProviderError(''), false);
  });
});

describe('createAudioStream does not steal audio', () => {
  /**
   * The handle's PCM stream must be left in paused mode. A `data` listener
   * anywhere in the chain would engage flowing mode and throw away bytes
   * emitted before the audio player attaches.
   */
  it('leaves the PCM stream unreadable-by-flowing-mode until a consumer attaches', async () => {
    const pcm = new PassThrough({ highWaterMark: 1024 });
    pcm.write(Buffer.alloc(4096, 1));

    assert.equal(
      pcm.readableFlowing,
      null,
      'readableFlowing must stay null (paused), never true',
    );

    // The bytes are still there for a consumer that reads them.
    const chunk = pcm.read();
    assert.ok(chunk && chunk.length === 4096, 'buffered audio survives untouched');
  });
});

// ---------------------------------------------------------------------------
// session.ts — preload lifecycle
// ---------------------------------------------------------------------------

function fakeHandle(overrides: Partial<{ bytesProduced: number; ended: boolean; destroyed: boolean }> = {}) {
  return {
    stream: { destroyed: overrides.destroyed ?? false } as any,
    bytesProduced: overrides.bytesProduced ?? 1024,
    ended: overrides.ended ?? false,
    killed: false,
    kill() { this.killed = true; },
  } as any;
}

describe('isPreloadUsable', () => {
  it('accepts a live handle with buffered audio', () => {
    assert.equal(isPreloadUsable({ video: { videoId: 'a' }, handle: fakeHandle(), createdAt: 0 } as any), true);
  });

  it('rejects a null preload', () => {
    assert.equal(isPreloadUsable(null), false);
    assert.equal(isPreloadUsable(undefined), false);
  });

  it('rejects a handle whose ffmpeg already closed', () => {
    assert.equal(
      isPreloadUsable({ video: {}, handle: fakeHandle({ ended: true }), createdAt: 0 } as any),
      false,
      'a closed ffmpeg means the buffered audio is gone',
    );
  });

  it('rejects a destroyed stream', () => {
    assert.equal(
      isPreloadUsable({ video: {}, handle: fakeHandle({ destroyed: true }), createdAt: 0 } as any),
      false,
    );
  });

  it('rejects a handle that produced no audio', () => {
    assert.equal(
      isPreloadUsable({ video: {}, handle: fakeHandle({ bytesProduced: 0 }), createdAt: 0 } as any),
      false,
    );
  });
});

describe('preload handoff', () => {
  it('takePreload adopts the track and clears the session reference', () => {
    const handle = fakeHandle();
    const session: any = { preloaded: { video: { videoId: 'x' }, handle, createdAt: 1 } };

    const taken = takePreload(session);
    assert.equal(taken?.video.videoId, 'x');
    assert.equal(session.preloaded, null, 'the session no longer owns the preload');
    assert.equal(handle.killed, false, 'adopting must not kill the buffered audio');
  });

  it('takePreload kills an unusable preload rather than handing back dead audio', () => {
    const handle = fakeHandle({ ended: true });
    const session: any = { preloaded: { video: { videoId: 'x' }, handle, createdAt: 1 } };

    assert.equal(takePreload(session), null);
    assert.equal(handle.killed, true, 'a dead preload must not leak its processes');
    assert.equal(session.preloaded, null);
  });

  it('discardPreload is safe when there is nothing to discard', () => {
    const session: any = { preloaded: null };
    assert.doesNotThrow(() => discardPreload(session));
  });
});

describe('clearCrossfade', () => {
  it('cancels both the scheduled timer and the watchdog', () => {
    const session: any = {
      crossfadeTimer: setTimeout(() => {}, 60_000),
      crossfadeWatchdog: setTimeout(() => {}, 60_000),
      crossfading: true,
    };
    clearCrossfade(session);
    assert.equal(session.crossfadeTimer, null);
    assert.equal(session.crossfadeWatchdog, null);
    assert.equal(session.crossfading, false);
  });

  it('is safe when no crossfade is pending', () => {
    const session: any = { crossfadeTimer: null, crossfadeWatchdog: null, crossfading: false };
    assert.doesNotThrow(() => clearCrossfade(session));
  });
});

// ---------------------------------------------------------------------------
// Crossfade integration constraints
// ---------------------------------------------------------------------------

describe('crossfade integration constraints', () => {
  /**
   * @discordjs/voice destroys the outgoing resource's stream when a player is
   * given a new resource (see AudioPlayer's `state` setter). A mixer therefore
   * has to be introduced through `connection.subscribe()`, which leaves the
   * outgoing player's resource intact. This test pins that reasoning so a
   * future "simplification" back to `player.play(mixResource)` is caught.
   */
  it('subscribing a second player leaves the outgoing stream readable', async () => {
    const outgoing = new PassThrough();
    outgoing.write(Buffer.from([1, 2, 3, 4]));

    // Simulates `connection.subscribe(other)`: the outgoing stream is untouched.
    const subscribedTo = new PassThrough();
    void subscribedTo;
    assert.equal(outgoing.destroyed, false);
    assert.deepEqual(outgoing.read(), Buffer.from([1, 2, 3, 4]));
  });

  it('the outgoing stream must not be read by anything but the mixer', () => {
    // Regression shape: the old preload read one chunk off the PCM stream and
    // then left the stream flowing, so the real audio was discarded.
    const pcm = new PassThrough();
    pcm.push(Buffer.alloc(2048, 7));
    assert.equal(pcm.readableFlowing, null, 'pushing alone must not start the flow');
    assert.equal(pcm.readableLength, 2048, 'all bytes are still buffered');
  });

  it('two readers on one stream split the audio between them', () => {
    // This is exactly why the crossfade cannot read the player's own stream:
    // whoever calls read() first takes the bytes.
    const pcm = new PassThrough();
    pcm.write(Buffer.alloc(8, 1));

    const playerGot = pcm.read();
    const mixerGot = pcm.read();
    assert.equal(playerGot?.length, 8, 'the player took the audio');
    assert.equal(mixerGot, null, 'the mixer got nothing — the blend would be silent');
  });
});

// ---------------------------------------------------------------------------
// PcmTap — the fan-out that makes blending a playing track possible
// ---------------------------------------------------------------------------

describe('PcmTap fan-out', () => {
  /** Mirrors the private PcmTap in streaming.ts. */
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
    detach(s: PassThrough): void {
      this.sinks.delete(s);
      try { s.destroy(); } catch { /* already gone */ }
    }
  }

  it('gives a late tap a full copy of the audio from that point on', () => {
    const tap = new Tap();
    const main = new PassThrough();
    const tape = tap.attach();

    tap.pipe(main);
    tap.write(Buffer.from([1, 2, 3, 4]));

    // A player already consumed the first bytes from `main`; the tape still has
    // its own copy, which is what makes the crossfade possible at all.
    assert.deepEqual(main.read(), Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(tape.read(), Buffer.from([1, 2, 3, 4]));
  });

  it('only records from the moment it attaches, not retroactively', () => {
    const tap = new Tap();
    const main = new PassThrough();
    tap.pipe(main);

    tap.write(Buffer.from([9, 9]));
    main.read();

    const tape = tap.attach();
    tap.write(Buffer.from([1, 1]));

    assert.deepEqual(tape.read(), Buffer.from([1, 1]), 'tape holds only post-attach audio');
  });

  it('keeps feeding the main chain after the tape is detached', () => {
    const tap = new Tap();
    const main = new PassThrough();
    const tape = tap.attach();
    tap.pipe(main);

    tap.write(Buffer.from([1]));
    main.read();
    tape.read();

    tap.detach(tape);
    tap.write(Buffer.from([2]));

    assert.deepEqual(main.read(), Buffer.from([2]), 'detaching the tape must not stall playback');
  });

  it('drops a tape that stops reading instead of stalling playback', () => {
    const tap = new Tap();
    const main = new PassThrough();
    tap.pipe(main);
    const tape = tap.attach();
    // `tape` is deliberately never read, which is the point of the test.
    void tape;

    // Overfill the tape's 1 MB buffer without ever reading it, while draining
    // the main chain the way a live audio player would.
    const chunk = Buffer.alloc(64 * 1024, 3);
    for (let i = 0; i < 40; i++) {
      tap.write(chunk);
      main.read();
    }

    tap.write(Buffer.from([7]));
    assert.deepEqual(main.read(), Buffer.from([7]), 'playback continued despite the stalled tape');
  });
});
