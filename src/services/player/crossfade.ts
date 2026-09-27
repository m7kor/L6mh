/**
 * crossfade.ts — equal-power crossfade between two PCM streams.
 *
 * عند نهاية مقطع، بدلاً من قطعه قاطعاً، نمزج بين صوت المقطع الحالي وصوت
 * المقطع التالي خلال فترة انتقالية. منحنيات cos/sin (equal-power) تحافظ على
 * مستوى الصوت خلال الانتقال — لا توجد نقطة هدوء في المنتصف كما في fade خطي.
 *
 * Format: s16le PCM, 48 kHz, stereo.
 *
 * Correctness properties this implementation guarantees:
 *
 *  1. **The window opens on the first emitted frame.** The mixer is created at
 *     the instant the transition should begin, so there is no "pre" phase to
 *     mis-measure. Gains are derived from bytes emitted *inside* the window
 *     only. (The previous implementation derived `t` from the cumulative
 *     stream offset, so by the time the window opened it was already over and
 *     the mix never actually happened.)
 *
 *  2. **No dropped audio.** Each source is buffered in a FIFO queue, not a
 *     single pending slot — the old code overwrote `pendingCur` on every chunk
 *     and silently discarded the rest. Sources are paused once their buffer
 *     exceeds a high-water mark and resumed as it drains, so backpressure
 *     reaches ffmpeg/yt-dlp instead of discarding decoded audio.
 *
 *  3. **No flowing-mode data loss.** A `data` listener forces flowing mode and
 *     consumes bytes before the consumer reads them. We use `readable` plus
 *     `read()` throughout, which never does that.
 *
 *  4. **Frame alignment.** Sources chunk arbitrarily, so a carry buffer always
 *     holds the partial sample frame between reads; `mix()` only ever sees
 *     whole frames.
 *
 *  5. **Cheap gain curves.** cos/sin are evaluated once per ramp step into a
 *     small table and interpolated, keeping millions of transcendental calls
 *     off the event loop.
 *
 *  6. **Starvation degrades gracefully.** If the next track runs dry mid
 *     window, the current track continues under its own decaying envelope
 *     rather than inserting silence.
 */

import { Readable } from 'node:stream';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('audio');

/** L16 (2B) + R16 (2B) = 4 bytes per sample frame. */
export const SAMPLE_FRAME_SIZE = 4;
/** 48,000 frames/s × 4 bytes. */
export const BYTES_PER_SECOND = 48_000 * SAMPLE_FRAME_SIZE;

/** Resolution of the precomputed equal-power ramp. */
const RAMP_STEP_MS = 10;

const EMPTY = Buffer.alloc(0);

export type CrossfadeState = 'fade' | 'tail' | 'done';

/** Minimal surface the mixer needs from a source stream. */
export interface PcmSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(error?: Error): unknown;
  read(size?: number): Buffer | string | null;
  readonly readableLength: number;
  readonly destroyed: boolean;
  readonly readableEnded?: boolean;
}

export interface CrossfadeOptions {
  /** Crossfade length in seconds. `0` degrades to a plain hard switch. */
  durationSec?: number;
  /** Pause a source once its buffer grows past this many bytes. */
  sourceHighWaterBytes?: number;
  /** Resume a source once its buffer drains below this many bytes. */
  sourceLowWaterBytes?: number;
  /** Fired once the crossfade window is fully behind us. */
  onCrossfadeComplete?: () => void;
}

interface SourceSlot {
  stream: PcmSource;
  queue: Buffer[];
  queuedBytes: number;
  ended: boolean;
  /** Partial sample frame carried between reads (0..SAMPLE_FRAME_SIZE-1). */
  carry: Buffer;
  paused: boolean;
}

/**
 * Emits the remainder of `current` crossfaded into `next`, then the remainder
 * of `next`. Nothing is dropped.
 */
export class CrossfadeReadable extends Readable {
  private readonly cur: SourceSlot;
  private readonly next: SourceSlot;
  private readonly fadeBytes: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly onCrossfadeComplete?: () => void;

  /** Bytes emitted *inside* the crossfade window — the gain ramp's clock. */
  private fadeProgressBytes = 0;
  private crossfadeCompleteFired = false;
  private state: CrossfadeState;
  private released = false;
  /** Re-entrancy guard: a source event can fire from inside `fill()`/`push()`. */
  private pumping = false;
  private pumpQueued = false;

  private readonly rampA: Float32Array;
  private readonly rampB: Float32Array;

  constructor(
    currentStream: PcmSource,
    nextStream: PcmSource,
    options: CrossfadeOptions | number = {},
  ) {
    super({ highWaterMark: 1024 * 128 });

    const opts: CrossfadeOptions = typeof options === 'number' ? { durationSec: options } : options;
    const seconds = Math.max(0, opts.durationSec ?? 4);

    this.fadeBytes = Math.floor(seconds * BYTES_PER_SECOND);
    this.highWater = opts.sourceHighWaterBytes ?? 1024 * 1024;
    this.lowWater = opts.sourceLowWaterBytes ?? 1024 * 128;
    this.onCrossfadeComplete = opts.onCrossfadeComplete;

    this.cur = this.makeSlot(currentStream);
    this.next = this.makeSlot(nextStream);
    // A zero-length window is a hard switch: emit the next track alone and
    // never read the outgoing one.
    this.state = this.fadeBytes > 0 ? 'fade' : 'tail';

    const steps = Math.max(2, Math.ceil((seconds * 1000) / RAMP_STEP_MS) + 1);
    this.rampA = new Float32Array(steps);
    this.rampB = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const phase = seconds > 0 ? (i / (steps - 1)) * (Math.PI / 2) : Math.PI / 2;
      this.rampA[i] = Math.cos(phase);
      this.rampB[i] = Math.sin(phase);
    }

    // `readable` keeps us out of flowing mode, so no PCM is consumed here.
    //
    // Source events must *drive* the mixer rather than merely nudge it. A
    // source's `end` is emitted asynchronously, after `fill()` already drained
    // it, so a mixer that only ever reacts to `_read` would stall in `tail`
    // with both queues empty and never emit the terminating null. Pushing from
    // an event handler is safe, and it works for both consumer styles
    // (`readable`+`read()` as @discordjs/voice uses, and flowing `data`).
    const wake = () => this.pumpOutput();
    this.cur.stream.on('readable', wake);
    this.next.stream.on('readable', wake);
    this.cur.stream.on('end', () => { this.cur.ended = true; wake(); });
    this.next.stream.on('end', () => { this.next.ended = true; wake(); });
    this.cur.stream.on('close', () => { this.cur.ended = true; wake(); });
    this.next.stream.on('close', () => { this.next.ended = true; wake(); });

    this.cur.stream.on('error', (err: Error) => this.failSource('current', err));
    this.next.stream.on('error', (err: Error) => this.failSource('next', err));
  }

  private makeSlot(stream: PcmSource): SourceSlot {
    const slot: SourceSlot = { stream, queue: [], queuedBytes: 0, ended: false, carry: EMPTY, paused: false };
    // Neither source may flow on its own — we pull from them.
    try { stream.pause(); } catch { /* not pausable */ }
    return slot;
  }

  // -------------------------------------------------------------------------
  // Pulling from a source
  // -------------------------------------------------------------------------

  /**
   * Drain everything currently available into the slot's queue.
   * Reading here (rather than via `data`) is what keeps the stream out of
   * flowing mode, so nothing is consumed before the mixer asks for it.
   */
  private fill(slot: SourceSlot): void {
    if (slot.ended) return;
    let chunk: Buffer | string | null;
    while ((chunk = slot.stream.read()) !== null) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (buf.length === 0) continue;
      slot.queue.push(buf);
      slot.queuedBytes += buf.length;
    }
    if (slot.stream.readableEnded && slot.queuedBytes === 0) return;
  }

  /** Total bytes available, including a partial carried frame. */
  private available(slot: SourceSlot): number {
    return slot.queuedBytes + slot.carry.length;
  }

  private exhausted(slot: SourceSlot): boolean {
    return slot.ended && this.available(slot) === 0;
  }

  /**
   * Take whole sample frames, up to `wantBytes`, never returning a partial
   * frame. Returns `null` when not even one full frame is available yet.
   */
  private takeFrames(slot: SourceSlot, wantBytes: number): Buffer | null {
    // Top the carry up to a complete frame, or bail if we cannot.
    if (slot.carry.length > 0) {
      if (slot.queuedBytes === 0) return null;
      const missing = SAMPLE_FRAME_SIZE - slot.carry.length;
      const got = this.shiftFromQueue(slot, Math.min(missing, slot.queuedBytes));
      slot.carry = Buffer.concat([slot.carry, got]);
    }

    if (slot.carry.length === SAMPLE_FRAME_SIZE) {
      const frame = slot.carry;
      slot.carry = EMPTY;
      const rest = this.takeAligned(slot, Math.max(0, wantBytes - SAMPLE_FRAME_SIZE));
      return rest ? Buffer.concat([frame, rest], frame.length + rest.length) : frame;
    }

    return this.takeAligned(slot, wantBytes);
  }

  private takeAligned(slot: SourceSlot, wantBytes: number): Buffer | null {
    if (slot.queuedBytes < SAMPLE_FRAME_SIZE) return null;
    const bytes = Math.min(wantBytes, slot.queuedBytes);
    const aligned = Math.floor(bytes / SAMPLE_FRAME_SIZE) * SAMPLE_FRAME_SIZE;
    if (aligned < SAMPLE_FRAME_SIZE) return null;
    return this.shiftFromQueue(slot, aligned);
  }

  private shiftFromQueue(slot: SourceSlot, bytes: number): Buffer {
    const first = slot.queue[0];

    if (first.length === bytes) {
      slot.queue.shift();
      slot.queuedBytes -= bytes;
      this.maybeResume(slot);
      return first;
    }

    if (first.length > bytes) {
      const head = first.subarray(0, bytes);
      slot.queue[0] = first.subarray(bytes);
      slot.queuedBytes -= bytes;
      this.maybeResume(slot);
      return head;
    }

    // Spans several queued chunks.
    const parts: Buffer[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = slot.queue[0];
      if (!chunk) break;
      const size = Math.min(chunk.length, remaining);
      parts.push(chunk.subarray(0, size));
      remaining -= size;
      slot.queuedBytes -= size;
      if (size === chunk.length) slot.queue.shift();
      else slot.queue[0] = chunk.subarray(size);
    }
    this.maybeResume(slot);
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, bytes);
  }

  private maybeResume(slot: SourceSlot): void {
    if (slot.paused && slot.queuedBytes <= this.lowWater) {
      slot.paused = false;
      try { slot.stream.resume(); } catch { /* not resumable */ }
    }
  }

  private maybePause(slot: SourceSlot): void {
    if (!slot.paused && slot.queuedBytes >= this.highWater) {
      slot.paused = true;
      try { slot.stream.pause(); } catch { /* not pausable */ }
    }
  }

  private failSource(which: 'current' | 'next', err: Error): void {
    if (this.destroyed) return;
    logger.debug(`[crossfade] ${which} source error: ${err.message}`);
    this.destroy(err);
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  override _read(): void {
    this.pumpOutput();
  }

  /**
   * Drive one pass of the mix, re-running if a source event arrives mid-pass.
   * Safe to call from `_read` and from source event handlers alike.
   */
  private pumpOutput(): void {
    if (this.destroyed) return;
    if (this.pumping) {
      this.pumpQueued = true;
      return;
    }

    this.pumping = true;
    try {
      do {
        this.pumpQueued = false;
        this.pumpOnce();
      } while (this.pumpQueued && !this.destroyed && this.state !== 'done');
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    this.fill(this.cur);
    this.fill(this.next);

    // ~0.5 s of audio per emitted chunk.
    const want = 24_000 * SAMPLE_FRAME_SIZE;

    for (;;) {
      if (this.state === 'fade') {
        const a = this.takeFrames(this.cur, want);
        // Cap the incoming take to the outgoing chunk: whatever we pull from
        // `next` must be consumed, and over-taking would silently discard the
        // remainder. (The previous version took `b` in full and mixed only
        // `min(a,b)` bytes, throwing the rest of the next track away.)
        const b = a ? this.takeFrames(this.next, Math.min(want, a.length)) : null;

        if (!a) {
          // Current has nothing left — hand over to the next track untouched.
          if (this.exhausted(this.cur)) this.state = 'tail';
          break;
        }

        if (!b) {
          // Next track is not keeping up. Continue the current one under its
          // decaying envelope rather than inserting a gap.
          this.push(this.applyEnvelope(a));
          this.fadeProgressBytes += a.length;
          if (this.exhausted(this.next)) this.state = 'tail';
          break;
        }

        const length = Math.min(a.length, b.length);
        this.push(this.mix(a.subarray(0, length), b.subarray(0, length)));
        this.fadeProgressBytes += length;

        if (length < a.length) {
          // `next` ran out mid-chunk; carry on with the current track.
          this.push(this.applyEnvelope(a.subarray(length)));
        }

        if (this.fadeProgressBytes >= this.fadeBytes || this.exhausted(this.cur)) {
          this.state = 'tail';
          this.fireCrossfadeComplete();
        }
        continue;
      }

      if (this.state === 'tail') {
        if (this.exhausted(this.next)) {
          this.state = 'done';
          break;
        }
        const buf = this.takeFrames(this.next, want);
        if (!buf) break;
        this.push(buf);
        continue;
      }

      break;
    }

    this.maybePause(this.cur);
    this.maybePause(this.next);

    if (this.state === 'done') {
      this.push(null);
      this.releaseSources();
    }
  }

  /**
   * Scale a buffer by the equal-power *outgoing* ramp for the current window
   * position, without mixing a second source in. Used when the next track
   * cannot keep up, so playback continues to degrade smoothly instead of
   * inserting a gap.
   */
  private applyEnvelope(buf: Buffer): Buffer {
    const out = Buffer.alloc(buf.length);
    const lastStep = this.rampA.length - 1;
    for (let i = 0; i < buf.length; i += SAMPLE_FRAME_SIZE) {
      const ratio = this.fadeBytes > 0 ? Math.min(1, (this.fadeProgressBytes + i) / this.fadeBytes) : 1;
      const exact = ratio * lastStep;
      const idx = Math.min(lastStep - 1, Math.floor(exact));
      const frac = exact - idx;
      const gA = this.rampA[idx] + (this.rampA[idx + 1] - this.rampA[idx]) * frac;

      out.writeInt16LE(clamp16(buf.readInt16LE(i) * gA), i);
      out.writeInt16LE(clamp16(buf.readInt16LE(i + 2) * gA), i + 2);
    }
    return out;
  }

  /**
   * Mix two frame-aligned buffers with the equal-power ramp.
   * `t` is the position *inside* the crossfade window.
   */
  private mix(a: Buffer, b: Buffer): Buffer {
    const frames = Math.floor(a.length / SAMPLE_FRAME_SIZE);
    const out = Buffer.alloc(frames * SAMPLE_FRAME_SIZE);
    const lastStep = this.rampA.length - 1;

    for (let i = 0; i < frames; i++) {
      const byteOffset = i * SAMPLE_FRAME_SIZE;
      const ratio = this.fadeBytes > 0
        ? Math.min(1, (this.fadeProgressBytes + byteOffset) / this.fadeBytes)
        : 1;

      const exact = ratio * lastStep;
      const idx = Math.min(lastStep - 1, Math.floor(exact));
      const frac = exact - idx;
      const gA = this.rampA[idx] + (this.rampA[idx + 1] - this.rampA[idx]) * frac;
      const gB = this.rampB[idx] + (this.rampB[idx + 1] - this.rampB[idx]) * frac;

      const l = clamp16(a.readInt16LE(byteOffset) * gA + b.readInt16LE(byteOffset) * gB);
      const r = clamp16(a.readInt16LE(byteOffset + 2) * gA + b.readInt16LE(byteOffset + 2) * gB);

      out.writeInt16LE(l, byteOffset);
      out.writeInt16LE(r, byteOffset + 2);
    }

    return out;
  }

  private fireCrossfadeComplete(): void {
    if (this.crossfadeCompleteFired) return;
    this.crossfadeCompleteFired = true;
    // The current source has fully faded out; release it so ffmpeg/yt-dlp
    // exit instead of idling forever on a blocked pipe.
    try { this.cur.stream.destroy(); } catch { /* already gone */ }
    try { this.onCrossfadeComplete?.(); } catch { /* a bad callback must not break playback */ }
  }

  private releaseSources(): void {
    if (this.released) return;
    this.released = true;
    try { this.cur.stream.destroy(); } catch { /* already gone */ }
    try { this.next.stream.destroy(); } catch { /* already gone */ }
  }

  /** Introspection for tests. */
  get debugState(): { state: CrossfadeState; curQueued: number; nextQueued: number; fadeProgress: number } {
    return {
      state: this.state,
      curQueued: this.available(this.cur),
      nextQueued: this.available(this.next),
      fadeProgress: this.fadeProgressBytes,
    };
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    this.releaseSources();
    cb(err);
  }
}

function clamp16(v: number): number {
  const r = Math.round(v);
  if (r > 32767) return 32767;
  if (r < -32768) return -32768;
  return r;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function createCrossfade(
  currentStream: PcmSource,
  nextStream: PcmSource,
  options: CrossfadeOptions | number = {},
): CrossfadeReadable {
  return new CrossfadeReadable(currentStream, nextStream, options);
}

/** هل يمكن تطبيق المزج الآن؟ */
export function canCrossfade(session: {
  player?: unknown;
  current?: { durationSeconds?: number | null; progressSeconds?: number } | null;
}): boolean {
  if (!session.player) return false;
  if (!session.current) return false;
  if (!session.current.durationSeconds) return false;
  if (session.current.durationSeconds <= 0) return false;
  if ((session.current.progressSeconds || 0) < 1) return false;
  return true;
}

/** متى نبدأ المزج؟ نبدأ قبل نهاية المقطع الحالي بـ durationSec. */
export function crossfadeStartTime(currentDuration: number, crossfadeDuration: number): number {
  return Math.max(0, currentDuration - crossfadeDuration);
}
