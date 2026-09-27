import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  CrossfadeReadable,
  createCrossfade,
  canCrossfade,
  crossfadeStartTime,
  BYTES_PER_SECOND,
  SAMPLE_FRAME_SIZE,
} from './crossfade.js';

/** A source that emits `frames` constant-amplitude sample frames. */
function pcmSource(frames: number, l: number, r: number): Readable {
  const s = new Readable({ read() {} });
  s.push(framesBuffer(frames, l, r));
  s.push(null);
  return s;
}

/** A source that emits exactly `totalFrames` in fixed-size chunks. */
function chunkedSource(totalFrames: number, chunkFrames: number, l: number, r: number): Readable {
  const s = new Readable({ read() {} });
  let emitted = 0;
  while (emitted < totalFrames) {
    const size = Math.min(chunkFrames, totalFrames - emitted);
    s.push(framesBuffer(size, l, r));
    emitted += size;
  }
  s.push(null);
  return s;
}

function framesBuffer(frames: number, l: number, r: number): Buffer {
  const buf = Buffer.alloc(frames * SAMPLE_FRAME_SIZE);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(clamp(l), i * SAMPLE_FRAME_SIZE);
    buf.writeInt16LE(clamp(r), i * SAMPLE_FRAME_SIZE + 2);
  }
  return buf;
}

function clamp(v: number): number {
  return Math.max(-32768, Math.min(32767, v | 0));
}

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on('data', (c) => parts.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

/** Window length expressed in sample frames. */
function windowFrames(seconds: number): number {
  return Math.floor((seconds * BYTES_PER_SECOND) / SAMPLE_FRAME_SIZE);
}

const SILENCE = 0;
const LOUD = 20_000;

describe('crossfade: output accounting', () => {
  /**
   * The listener hears the next track start at the transition and play to its
   * end, with the outgoing track blended over the window. The outgoing track's
   * frames are *overlapped* with the incoming track's first frames, so they do
   * not extend the timeline — total output is the next track's own length.
   */
  it('emits exactly the next track, with the window blended in', async () => {
    const seconds = 0.5;
    const win = windowFrames(seconds);
    const curFrames = win * 2; // longer than the window
    const nextFrames = win * 3;

    const out = await collect(new CrossfadeReadable(
      pcmSource(curFrames, LOUD, LOUD),
      pcmSource(nextFrames, SILENCE, SILENCE),
      seconds,
    ));

    assert.equal(
      out.length / SAMPLE_FRAME_SIZE,
      nextFrames,
      'the incoming track plays to completion; the outgoing one overlaps it',
    );
  });

  it('emits all of cur when cur is shorter than the window, then all of next', async () => {
    const seconds = 0.5;
    const win = windowFrames(seconds);
    const curFrames = win / 4;
    const nextFrames = win * 2;

    const out = await collect(new CrossfadeReadable(
      pcmSource(curFrames, LOUD, LOUD),
      pcmSource(nextFrames, 1_000, 1_000),
      seconds,
    ));

    assert.equal(
      out.length / SAMPLE_FRAME_SIZE,
      nextFrames,
      'a short current track is never truncated, and next still plays to the end',
    );
  });

  it('a zero window is a plain hard switch onto the next track', async () => {
    const frames = 4_000;
    const out = await collect(new CrossfadeReadable(
      pcmSource(frames, 1_000, 1_000),
      pcmSource(frames, 2_000, 2_000),
      0,
    ));
    assert.equal(
      out.length / SAMPLE_FRAME_SIZE,
      frames,
      'a hard switch emits only the incoming track',
    );
    assert.equal(
      out.readInt16LE(0),
      2_000,
      'and starts with the incoming track at unity gain',
    );
  });
});

describe('crossfade: equal-power window', () => {
  it('starts at unity gain on the current track', async () => {
    const seconds = 0.5;
    const win = windowFrames(seconds);
    const out = await collect(new CrossfadeReadable(
      pcmSource(win, LOUD, LOUD),
      pcmSource(win * 2, 1_000, 1_000),
      seconds,
    ));

    assert.equal(out.readInt16LE(0), LOUD, 'first frame is the current track, untouched');
    assert.equal(out.readInt16LE(2), LOUD, 'and so is its right channel');
  });

  it('reaches the next track at unity gain once the window closes', async () => {
    const seconds = 0.5;
    const win = windowFrames(seconds);
    const nextAmp = 9_000;
    const out = await collect(new CrossfadeReadable(
      pcmSource(win, SILENCE, SILENCE),
      pcmSource(win * 2, nextAmp, nextAmp),
      seconds,
    ));

    // One frame past the window the output must be pure next-track audio.
    const pastWindow = win + 5;
    assert.equal(
      out.readInt16LE(pastWindow * SAMPLE_FRAME_SIZE),
      nextAmp,
      'next track plays alone at full gain after the window',
    );
  });

  it('mixes both sources at the midpoint, following cos/sin', async () => {
    const seconds = 0.5;
    const win = windowFrames(seconds);
    const curAmp = 16_000;
    const nextAmp = 4_000;

    const out = await collect(new CrossfadeReadable(
      pcmSource(win, curAmp, curAmp),
      pcmSource(win * 2, nextAmp, nextAmp),
      seconds,
    ));

    const midFrame = Math.floor(win / 2);
    const expected = Math.round(curAmp * Math.cos(Math.PI / 4) + nextAmp * Math.sin(Math.PI / 4));
    const actual = out.readInt16LE(midFrame * SAMPLE_FRAME_SIZE);
    assert.ok(
      Math.abs(actual - expected) <= 4,
      `mid-window mix should be ~${expected} (cos·cur + sin·next), got ${actual}`,
    );
  });

  it('never dips to silence in the middle of the window', async () => {
    // Two identical sources at half scale. A linear (amplitude) crossfade
    // would pass through zero here; equal-power must not.
    const seconds = 0.5;
    const win = windowFrames(seconds);
    const amp = 12_000;

    const out = await collect(new CrossfadeReadable(
      pcmSource(win, amp, amp),
      pcmSource(win * 2, amp, amp),
      seconds,
    ));

    let minAbs = Infinity;
    for (let f = 0; f < win; f++) {
      const v = Math.abs(out.readInt16LE(f * SAMPLE_FRAME_SIZE));
      if (v < minAbs) minAbs = v;
    }
    // cos+sin has a minimum of 1.0 at the ends and peaks at sqrt(2) in the middle.
    assert.ok(
      minAbs >= amp * 0.98,
      `level must never collapse during the window; min was ${minAbs} vs ${amp}`,
    );
  });

  it('gain rises monotonically across the window', async () => {
    const seconds = 0.4;
    const win = windowFrames(seconds);
    const nextAmp = 10_000;

    const out = await collect(new CrossfadeReadable(
      pcmSource(win, 0, 0),
      pcmSource(win * 2, nextAmp, nextAmp),
      seconds,
    ));

    const at = (f: number) => Math.abs(out.readInt16LE(f * SAMPLE_FRAME_SIZE));
    const start = at(0);
    const mid = at(Math.floor(win / 2));
    const end = at(win - 1);

    assert.ok(start < mid, `incoming track must fade in: ${start} < ${mid}`);
    assert.ok(mid < end, `and keep rising: ${mid} < ${end}`);
    assert.ok(Math.abs(end - nextAmp) <= 4, `reaches unity at the end: ${end} vs ${nextAmp}`);
  });
});

describe('crossfade: no audio loss', () => {
  it('preserves every frame from fragmented sources', async () => {
    const totalFrames = 3_000;
    // 37 frames per chunk, and 37 shares no factor with the window size, so
    // chunk boundaries never line up with sample-frame or window boundaries.
    const out = await collect(new CrossfadeReadable(
      chunkedSource(totalFrames, 37, 500, 500),
      chunkedSource(totalFrames, 37, 700, 700),
      0.05,
    ));

    assert.equal(
      out.length / SAMPLE_FRAME_SIZE,
      totalFrames,
      'fragmented sources must not lose or duplicate frames',
    );
  });

  it('always emits whole sample frames', async () => {
    const out = await collect(new CrossfadeReadable(
      chunkedSource(1_000, 13, 300, 300),
      chunkedSource(1_000, 7, 900, 900),
      0.02,
    ));
    assert.equal(
      out.length % SAMPLE_FRAME_SIZE,
      0,
      'output must be a whole number of stereo sample frames',
    );
  });

  it('handles a current track that ends long before the next', async () => {
    const win = windowFrames(0.02);
    const out = await collect(new CrossfadeReadable(
      pcmSource(win / 4, LOUD, LOUD),
      pcmSource(win * 2, 1_000, 1_000),
      0.02,
    ));
    assert.equal(out.length / SAMPLE_FRAME_SIZE, win * 2, 'the next track still plays to its end');
  });

  it('handles a next track that ends during the window', async () => {
    const win = windowFrames(0.2);
    const out = await collect(new CrossfadeReadable(
      pcmSource(win * 3, 1_000, 1_000),
      pcmSource(win / 8, LOUD, LOUD),
      0.2,
    ));
    // Window is exhausted by `next` early, so the remainder of `cur` is
    // emitted at full gain after the window has already been satisfied.
    assert.equal(out.length / SAMPLE_FRAME_SIZE, win * 3);
  });

  it('handles both sources ending immediately without hanging', async () => {
    const out = await collect(new CrossfadeReadable(
      pcmSource(1, 10, 10),
      pcmSource(1, 20, 20),
      0.001,
    ));
    assert.ok(out.length >= SAMPLE_FRAME_SIZE, 'must emit a frame rather than stall');
  });
});

describe('crossfade: lifecycle', () => {
  it('fires onCrossfadeComplete exactly once', async () => {
    let hits = 0;
    const win = windowFrames(0.2);
    await collect(new CrossfadeReadable(
      pcmSource(win, 100, 100),
      pcmSource(win * 2, 200, 200),
      { durationSec: 0.2, onCrossfadeComplete: () => { hits += 1; } },
    ));
    assert.equal(hits, 1);
  });

  it('propagates a source error rather than hanging', async () => {
    const bad = new Readable({ read() { this.destroy(new Error('boom')); } });
    await assert.rejects(
      collect(new CrossfadeReadable(bad, pcmSource(100, 1, 1), 0.01)),
      /boom/,
    );
  });

  it('a failing onCrossfadeComplete callback does not break playback', async () => {
    const win = windowFrames(0.1);
    const out = await collect(new CrossfadeReadable(
      pcmSource(win, 100, 100),
      pcmSource(win * 2, 200, 200),
      { durationSec: 0.1, onCrossfadeComplete: () => { throw new Error('callback exploded'); } },
    ));
    assert.ok(out.length > 0, 'audio still flowed');
  });

  it('createCrossfade returns a CrossfadeReadable', () => {
    const cf = createCrossfade(pcmSource(1, 0, 0), pcmSource(1, 0, 0));
    assert.ok(cf instanceof CrossfadeReadable);
    cf.destroy();
  });
});

describe('canCrossfade', () => {
  it('false: no player', () => assert.equal(canCrossfade({ player: null, current: { durationSeconds: 100 } }), false));
  it('false: no current', () => assert.equal(canCrossfade({ player: {}, current: null }), false));
  it('false: no duration', () => assert.equal(canCrossfade({ player: {}, current: {} }), false));
  it('false: duration 0', () => assert.equal(canCrossfade({ player: {}, current: { durationSeconds: 0 } }), false));
  it('false: progress 0', () => assert.equal(canCrossfade({ player: {}, current: { durationSeconds: 100, progressSeconds: 0 } }), false));
  it('true: all ok', () => assert.equal(canCrossfade({ player: {}, current: { durationSeconds: 100, progressSeconds: 50 } }), true));
});

describe('crossfadeStartTime', () => {
  it('equal', () => assert.equal(crossfadeStartTime(4, 4), 0));
  it('longer', () => assert.equal(crossfadeStartTime(100, 4), 96));
  it('shorter', () => assert.equal(crossfadeStartTime(2, 4), 0));
  it('zero', () => assert.equal(crossfadeStartTime(0, 4), 0));
});
