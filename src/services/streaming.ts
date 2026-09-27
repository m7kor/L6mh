/**
 * Audio streaming — yt-dlp → ffmpeg → raw PCM, plus process cleanup.
 *
 * Design notes that matter for reliability:
 *
 *  - Streams are handed back as a live handle (`AudioStreamHandle`), not a
 *    one-shot promise. The PCM `PassThrough` is deliberately left in paused
 *    (non-flowing) mode: the caller decides when to start consuming. That is
 *    what makes preloading possible — a preloaded handle holds real, already
 *    decoded audio instead of a process whose output is thrown away.
 *
 *  - A handle owns its own child processes. Preloading the next track and
 *    playing the current one therefore never clobber each other's process
 *    references.
 *
 *  - Nothing here attaches a persistent `data` listener to the PCM stream. A
 *    `data` listener forces flowing mode, which silently discards bytes
 *    emitted before the consumer attaches. Byte counting goes through a
 *    counting Transform, and the engine polls `handle.bytesProduced`.
 *
 *  - External tools are invoked exactly once per track. A URL's reachability is
 *    decided by the real streaming attempt, which already classifies the
 *    failure (auth / PoT / network) and rotates providers.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { TtlCache } from '../utils/ttl-cache.js';
import { formatTime } from '../utils/format.js';
import { getCookieArgs } from './cookies.js';
import { notify } from '../utils/webhook.js';

const logger = createLogger('audio');

const STDERR_TAIL_BYTES = 4096;
const STREAM_START_TIMEOUT_MS = 45_000;
const LIVE_PROBE_TIMEOUT_MS = 10_000;
const LIVE_CACHE_TTL_MS = 30 * 60 * 1000;

let consecutiveAuthFails = 0;
const AUTH_FAIL_THRESHOLD = 3;

export function getConsecutiveAuthFails(): number {
  return consecutiveAuthFails;
}

/**
 * Bounded rolling capture of a child process' stderr, so failures can be
 * classified without buffering an unbounded amount of output.
 */
function createTailBuffer(maxBytes: number = STDERR_TAIL_BYTES) {
  let tail = '';
  return {
    append(chunk: unknown) {
      tail += String(chunk);
      if (tail.length > maxBytes) tail = tail.slice(-maxBytes);
    },
    get value(): string {
      return tail;
    },
  };
}

function noteStreamFailure(): void {
  consecutiveAuthFails += 1;
  if (consecutiveAuthFails >= AUTH_FAIL_THRESHOLD) {
    notify(
      '\u26a0\ufe0f \u062a\u0639\u0630\u0631 \u0627\u0644\u062a\u062d\u0642\u064a\u0642',
      `\u0641\u0634\u0644 \u0627\u0644\u0628\u062b ${consecutiveAuthFails} \u0645\u0631\u0627\u062a \u0645\u062a\u062a\u0627\u0644\u064a\u0629 \u2014 \u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u0644\u0643\u0648\u0643\u064a\u0632 \u0623\u0648 \u0645\u0632\u0648\u062f PoT`,
      'error',
    ).catch(() => {});
    consecutiveAuthFails = 0;
  }
}

function noteStreamSuccess(): void {
  consecutiveAuthFails = 0;
}

// ---------------------------------------------------------------------------
// Global process tracker -- finds yt-dlp / ffmpeg pairs nothing is using
// ---------------------------------------------------------------------------

/**
 * A child process plus who, if anyone, is still using it.
 *
 * Ownership is the whole point: a handle that is abandoned without being killed
 * leaves ffmpeg blocked writing into a pipe nobody reads, and neither process
 * ever emits `close`, so the tracker never sheds them. Nothing in the process
 * table distinguishes that from healthy playback, and the leak is invisible
 * until the box runs out of memory.
 */
interface TrackedProcess {
  proc: ChildProcessWithoutNullStreams;
  owner: AudioStreamHandle | null;
  startedAt: number;
}

/** How long an unowned process is given before it is considered abandoned. */
const ORPHAN_GRACE_MS = 120_000;
/** Hard ceiling on tracked processes, well above the 2-4 a busy bot needs. */
const MAX_TRACKED_PROCESSES = 64;

const activeProcesses = new Map<ChildProcessWithoutNullStreams, TrackedProcess>();

function trackProcess(proc: ChildProcessWithoutNullStreams, owner: AudioStreamHandle | null = null): void {
  const entry: TrackedProcess = { proc, owner, startedAt: Date.now() };
  activeProcesses.set(proc, entry);
  const drop = () => { activeProcesses.delete(proc); };
  proc.on('close', drop);
  proc.on('error', drop);
}

/** Attribute already-tracked processes to the handle that owns them. */
function claimProcesses(owner: AudioStreamHandle, procs: ChildProcessWithoutNullStreams[]): void {
  for (const proc of procs) {
    const entry = activeProcesses.get(proc);
    if (entry) entry.owner = owner;
  }
}

export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

/** Tracked processes that no live handle is using. Should be 0 in steady state. */
export function getOrphanProcessCount(): number {
  let orphans = 0;
  for (const entry of activeProcesses.values()) {
    const owner = entry.owner;
    if (!owner || owner.ended || owner.killed) orphans += 1;
  }
  return orphans;
}

/**
 * Whether a tracked process has been abandoned and should be reaped.
 *
 * Split out from the reaper so the policy is testable without spawning real
 * children. The rule: only processes that are both past the grace period *and*
 * not owned by a live handle. Anything still owned by a handle that has neither
 * ended nor been killed is normal playback.
 */
export function shouldReapProcess(
  entry: { owner: AudioStreamHandle | null; startedAt: number },
  now: number,
  graceMs: number,
): boolean {
  if (now - entry.startedAt < graceMs) return false;
  const owner = entry.owner;
  if (owner && !owner.ended && !owner.killed) return false;
  return true;
}

/**
 * Kill child processes that no live handle is using.
 *
 * Returns how many were reaped.
 */
export function reapOrphanProcesses(graceMs: number = ORPHAN_GRACE_MS): number {
  const now = Date.now();
  let killed = 0;

  for (const [proc, entry] of activeProcesses) {
    if (!shouldReapProcess(entry, now, graceMs)) continue;

    if (entry.proc.exitCode === null && !entry.proc.killed) {
      try {
        entry.proc.kill('SIGKILL');
        killed += 1;
      } catch {
        /* already gone */
      }
    }
    activeProcesses.delete(proc);
  }

  if (killed > 0) logger.warn(`[streaming] Reaped ${killed} orphaned child process(es).`);
  return killed;
}

/** Reap, then log the tally. Exported for the periodic housekeeping hook. */
export function reapOrphanProcessesAndReport(): void {
  reapOrphanProcesses();
  const total = getActiveProcessCount();
  if (total > MAX_TRACKED_PROCESSES) {
    logger.warn(`[streaming] ${total} child processes tracked — far above the expected 2-4.`);
  }
}

// ---------------------------------------------------------------------------
// Dynamic PoT Provider Switching
// ---------------------------------------------------------------------------

/** Provider list, overridable via POT_PROVIDER_URLS (comma separated). */
const POT_PROVIDERS = (process.env.POT_PROVIDER_URLS || config.potProviderUrl)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let activeProviderIdx = 0;

/** The currently active provider URL. */
export function getActiveProvider(): string {
  return POT_PROVIDERS[activeProviderIdx] || config.potProviderUrl;
}

/** Rotate to the next provider in the list. */
export function switchToNextProvider(): void {
  if (POT_PROVIDERS.length <= 1) return;
  activeProviderIdx = (activeProviderIdx + 1) % POT_PROVIDERS.length;
  logger.warn(`[streaming] Switched to PoT provider #${activeProviderIdx}: ${getActiveProvider()}`);
  notify(
    '\ud83d\udd04 \u062a\u0628\u062f\u064a\u0644 \u0645\u0632\u0648\u062f',
    `\u062a\u0645 \u0627\u0644\u062a\u0628\u062f\u064a\u0644 \u0625\u0644\u0649 PoT Provider: \`${getActiveProvider()}\``,
    'warn',
  ).catch(() => {});
}

/** True when stderr suggests the PoT provider itself is unreachable. */
export function isPotProviderError(stderr: string): boolean {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();
  return (lower.includes('econnrefused') || lower.includes('connection refused')
    || lower.includes('etimedout') || lower.includes('connection timed out'))
    && lower.includes('bgutil');
}

function potExtractorArgs(): string[] {
  const provider = getActiveProvider();
  if (provider && provider !== 'none') {
    return ['--extractor-args', `youtubepot-bgutilhttp:base_url=${provider}`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Live-stream detection (cached -- a track is probed at most once per TTL)
// ---------------------------------------------------------------------------

/** Bounded: keyed by URL, so it grew to one entry per distinct track ever played. */
const liveCache = new TtlCache<boolean>(LIVE_CACHE_TTL_MS, 5_000);

/**
 * Detect whether a URL is a live stream.
 *
 * Result is cached: a normal video never becomes a live broadcast, so probing
 * once per TTL is enough. This used to run on every track transition, costing
 * an extra yt-dlp process each time.
 */
export function isLiveStream(url: string): Promise<boolean> {
  const cached = liveCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const args = [
      '--print', 'is_live',
      '--no-warnings', '--no-playlist', '--skip-download',
      ...potExtractorArgs(),
      ...getCookieArgs(),
      url,
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    trackProcess(proc as unknown as ChildProcessWithoutNullStreams);
    let settled = false;
    let output = '';

    const finish = (isLive: boolean, cache: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // SIGTERM first, then SIGKILL. A single SIGTERM leaves the process
      // tracked if yt-dlp ignores it, and the reaper would then take a full
      // grace period to clean up after every hung probe.
      if (proc.exitCode === null && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        const escalation = setTimeout(() => {
          if (proc.exitCode === null && !proc.killed) {
            try { proc.kill('SIGKILL'); } catch { /* gone */ }
          }
        }, 2_000);
        escalation.unref?.();
      }
      if (cache) liveCache.set(url, isLive);
      resolve(isLive);
    };

    const timer = setTimeout(() => finish(false, true), LIVE_PROBE_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => finish(output.trim().toLowerCase() === 'true', true));
    proc.on('error', () => finish(false, false));
  });
}

// ---------------------------------------------------------------------------
// Audio stream handles
// ---------------------------------------------------------------------------

/**
 * A PCM tap: every consumer that attaches receives a full copy of the audio.
 *
 * This exists because a Node Readable has a single consumer. An `AudioPlayer`
 * drains its stream in real time, so by the time a crossfade starts, the audio
 * we want to mix has already been consumed and cannot be re-read. Tapping fans
 * the PCM out to an extra PassThrough that stays paused until the crossfade
 * needs it, which is what makes blending an *already playing* track possible.
 */
class PcmTap extends Transform {
  private readonly sinks = new Set<PassThrough>();

  override _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback): void {
    for (const sink of this.sinks) {
      if (sink.destroyed) {
        this.sinks.delete(sink);
        continue;
      }
      // A sink that cannot keep up is dropped from rather than allowed to
      // back-pressure the whole feed — a stalled crossfade is far better than
      // a stalled radio.
      if (!sink.write(chunk)) this.sinks.delete(sink);
    }
    cb(null, chunk);
  }

  /** Attach a paused consumer and return its stream. */
  attach(): PassThrough {
    const sink = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.sinks.add(sink);
    return sink;
  }

  detach(sink: PassThrough | null | undefined): void {
    if (!sink) return;
    this.sinks.delete(sink);
    try { sink.destroy(); } catch { /* already destroyed */ }
  }
}

/**
 * A live PCM stream plus everything needed to supervise it.
 *
 * `stream` is a raw s16le / 48 kHz / stereo PassThrough held in paused mode.
 * Nothing is consumed until a consumer attaches, so a handle can sit idle
 * (preload) or be adopted mid-flight (crossfade) without losing audio.
 */
export interface AudioStreamHandle {
  readonly stream: PassThrough;
  /** Total PCM bytes ffmpeg has produced so far. Safe to poll. */
  readonly bytesProduced: number;
  /** True once ffmpeg has closed. */
  readonly ended: boolean;
  /** True once `kill()` has torn this handle down. */
  readonly killed: boolean;
  /**
   * Attach a second, paused consumer that receives a copy of all PCM produced
   * from now on. Used to record the tail of a track for crossfading.
   */
  tap(): PassThrough;
  /** Detach a tap previously returned by `tap()`. */
  untap(sink: PassThrough | null | undefined): void;
  /** Tear down both external processes and release the stream. */
  kill(): void;
}

export interface AudioStreamOptions {
  url: string;
  startSeconds?: number;
  /** 0..200 */
  volume?: number;
  durationSeconds?: number | null;
  /**
   * Apply a 3s fade-in / fade-out inside ffmpeg. Disable this when an external
   * mixer (crossfade) owns the amplitude envelope, otherwise the two envelopes
   * multiply and the transition collapses towards silence.
   */
  fades?: boolean;
}

/**
 * Tear down the audio a session is currently playing.
 *
 * Killing the handle is the whole job: each handle owns its own yt-dlp and
 * ffmpeg, so there is nothing else to reach for. This used to also null out
 * `ffmpegProcess` and `resolveProcess` on the session, but nothing ever
 * assigned them, so both branches were dead code with tests asserting on them —
 * coverage of a path that cannot execute.
 */
export function killProcesses(session: { activeHandle?: AudioStreamHandle | null }): void {
  if (!session.activeHandle) return;
  try { session.activeHandle.kill(); } catch { /* already gone */ }
  session.activeHandle = null;
}

/**
 * Build the ffmpeg audio filter chain.
 *
 * Order matters: the operator's volume is applied before loudness
 * normalisation so the volume setting survives it, and resampling is last.
 */
export function buildAudioFilter(
  volume: number,
  durationSeconds: number | null | undefined,
  fades: boolean,
): string {
  const parts = [
    `volume=${volume / 100}`,
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ];

  if (fades) {
    const fadeInSec = 3;
    const fadeOutSec = 3;
    parts.push(`afade=t=in:ss=0:d=${fadeInSec}`);
    if (durationSeconds != null && durationSeconds > fadeOutSec) {
      const fadeOutStart = (durationSeconds - fadeOutSec).toFixed(2);
      parts.push(`afade=t=out:st=${fadeOutStart}:d=${fadeOutSec}`);
    }
  }

  parts.push('aresample=48000');
  return parts.join(',');
}

/**
 * Spawn yt-dlp + ffmpeg and resolve once real audio is flowing.
 *
 * Rejects with a classified error on any external failure, so callers can
 * distinguish auth problems, PoT outages and generic network errors.
 */
export function createAudioStream(options: AudioStreamOptions): Promise<AudioStreamHandle> {
  const {
    url,
    startSeconds = 0,
    volume = 100,
    durationSeconds = null,
    fades = true,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let streamTimeout: NodeJS.Timeout | null = null;

    const ytDlpStderrTail = createTailBuffer();
    const ffmpegStderrTail = createTailBuffer();

    let produced = 0;
    let ended = false;
    let killed = false;

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        produced += chunk.length;
        cb(null, chunk);
      },
    });
    const tap = new PcmTap();

    // Held in paused mode on purpose: no `data` listener is ever attached, so
    // nothing is consumed (and therefore nothing lost) before a consumer wires
    // this stream into an audio resource.
    const pcm = new PassThrough({ highWaterMark: 1024 * 128 });

    const ytdlpArgs = [
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '-o', '-',
      '--no-part',
      ...potExtractorArgs(),
      ...getCookieArgs(),
      '--socket-timeout', '180',
      '--retries', '15',
      '--fragment-retries', '30',
      '--retry-sleep', '5',
      url,
    ];

    const ffmpegArgs: string[] = [];
    if (startSeconds > 0) ffmpegArgs.push('-ss', String(startSeconds));
    ffmpegArgs.push(
      '-probesize', '32768',
      '-analyzeduration', '0',
      '-i', 'pipe:0',
      '-bufsize', '512k',
      '-af', buildAudioFilter(volume, durationSeconds, fades),
      '-vn',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    );

    const ytDlpProcess = spawn('yt-dlp', ytdlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    trackProcess(ytDlpProcess as unknown as ChildProcessWithoutNullStreams);

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    trackProcess(ffmpegProcess as unknown as ChildProcessWithoutNullStreams);

    /** Kill both external processes. Safe to call repeatedly. */
    const killChildren = () => {
      try { ytDlpProcess.kill('SIGKILL'); } catch { /* gone */ }
      try { ffmpegProcess.kill('SIGKILL'); } catch { /* gone */ }
    };

    const cleanup = () => {
      if (streamTimeout) { clearTimeout(streamTimeout); streamTimeout = null; }
    };

    const safeReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChildren();
      reject(err);
    };

    const safeResolve = (handle: AudioStreamHandle) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(handle);
    };

    streamTimeout = setTimeout(
      () => safeReject(new Error('Stream timeout \u2014 no audio data received')),
      STREAM_START_TIMEOUT_MS,
    );

    const handle: AudioStreamHandle = {
      stream: pcm,
      get bytesProduced() { return produced; },
      get ended() { return ended; },
      get killed() { return killed; },
      tap() { return tap.attach(); },
      untap(sink) { tap.detach(sink); },
      kill() {
        if (killed) return;
        killed = true;
        killChildren();
        try { pcm.destroy(); } catch { /* already destroyed */ }
      },
    };

    // Attribute both processes to this handle so the orphan reaper can tell
    // them apart from a pair that was forgotten about.
    claimProcesses(handle, [
      ytDlpProcess as unknown as ChildProcessWithoutNullStreams,
      ffmpegProcess as unknown as ChildProcessWithoutNullStreams,
    ]);

    ytDlpProcess.stderr.on('data', (chunk: Buffer) => { ytDlpStderrTail.append(chunk); });
    ffmpegProcess.stderr.on('data', (chunk: Buffer) => { ffmpegStderrTail.append(chunk); });

    ffmpegProcess.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      logger.error(`ffmpeg stdin error: ${err.message}`);
    });
    ytDlpProcess.stdout.on('error', () => {
      try { ffmpegProcess.kill('SIGKILL'); } catch { /* gone */ }
    });

    ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

    ytDlpProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
    ffmpegProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    ytDlpProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        try { ffmpegProcess.kill(); } catch { /* gone */ }
        const detail = ytDlpStderrTail.value.slice(-500).trim();
        noteStreamFailure();

        if (isPotProviderError(ytDlpStderrTail.value)) {
          logger.warn('[streaming] PoT provider unreachable \u2014 switching provider.');
          switchToNextProvider();
          safeReject(new Error(`yt-dlp failed \u2014 PoT provider unreachable at ${getActiveProvider()}${detail ? `\n${detail}` : ''}`));
        } else if (/HTTP Error 403/.test(ytDlpStderrTail.value) || /Sign in to confirm/.test(ytDlpStderrTail.value)) {
          logger.warn(`[streaming] YouTube auth error (code ${code}) \u2014 check cookies.`);
          safeReject(new Error(`yt-dlp auth error${detail ? `\n${detail}` : ''}`));
        } else {
          safeReject(new Error(`yt-dlp exited with code ${code}${detail ? `\n${detail}` : ''}`));
        }
        return;
      }
      try { ffmpegProcess.stdin.end(); } catch { /* already closed */ }
    });

    ffmpegProcess.stdout.pipe(counter).pipe(tap).pipe(pcm);

    // `readable` does not engage flowing mode and does not consume the buffer,
    // so resolving here cannot drop the audio we are about to hand over.
    pcm.once('readable', () => {
      noteStreamSuccess();
      safeResolve(handle);
    });

    ffmpegProcess.on('close', (code) => {
      if (!settled) {
        const detail = ffmpegStderrTail.value.slice(-500).trim();
        safeReject(new Error(`ffmpeg exited with code ${code} before producing audio${detail ? `\n${detail}` : ''}`));
        return;
      }
      ended = true;
      // ffmpeg is the only reader of yt-dlp's stdout. Once it has exited
      // nothing drains that pipe, so yt-dlp would sit blocked on a write until
      // its own 180s socket timeout expires — and in the meantime the tracker
      // still counts it as live.
      try { ytDlpProcess.kill('SIGKILL'); } catch { /* gone */ }
      if (produced < 48000 * 2 * 5) {
        logger.warn(`[streaming] Stream ended with only ${(produced / 1024).toFixed(1)}KB of audio — likely a dropped connection.`);
      }
    });

    logger.info(startSeconds > 0 ? `Resuming from ${formatTime(startSeconds)}...` : 'Streaming audio...');
  });
}
