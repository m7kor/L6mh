/**
 * Session management — GuildSession class, state persistence, progress tracking.
 * State is persisted per-guild in SQLite (session_state table) — no race conditions.
 * better-sqlite3 is synchronous, so atomicity is guaranteed at the DB level.
 */

import { config } from '../config.js';
import type { PassThrough } from 'node:stream';
import { createLogger } from '../utils/logger.js';
import { getVideos } from './youtube.js';
import { getDb } from '../utils/database.js';
import type { AudioStreamHandle } from './streaming.js';

const logger = createLogger('audio');
const PROGRESS_AUTOSAVE_MS = 15_000;

/** A catalog video as far as the player is concerned. */
export interface CatalogVideo {
  videoId: string;
  url: string;
  title?: string;
  thumbnail?: string | null;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  progressSeconds?: number;
  viewCount?: number | null;
  [key: string]: unknown;
}

/**
 * A track whose audio has already been resolved and is buffered, waiting to be
 * adopted at the track boundary. The handle stays live — this is what makes
 * transitions gapless instead of stalling on a fresh yt-dlp spawn.
 */
export interface PreloadedTrack {
  video: CatalogVideo;
  handle: AudioStreamHandle;
  createdAt: number;
}

/**
 * Everything the bot holds for one guild.
 *
 * Grouped by what owns it, because that is what determines who has to release
 * it. The audio group is torn down on every stop; the transition group is
 * cancelled on every stop *and* on every new track; the persisted group is
 * what gets written to SQLite.
 *
 * Seven fields that used to live here were removed: `ffmpegProcess` and
 * `resolveProcess` (never assigned — each handle owns its own processes now),
 * `stallTimeout`, `keepAliveTimer`, `volumeTimer`, `stallRestarts` (all
 * vestigial), and `advancingSince` (written, never read).
 */
export class GuildSession {
  // --- Discord objects -----------------------------------------------------
  guildId: string;
  guild: any;
  channel: any;
  connection: any;
  nowPlayingMessage: any;

  // --- Currently playing ---------------------------------------------------
  player: any;
  resource: any;
  /** PCM stream currently feeding the player. Owns its child processes. */
  activeHandle: AudioStreamHandle | null;
  current: any;
  paused: boolean;
  mode: string | null;
  volume: number;
  interjecting: boolean;
  isLive: boolean;
  /** Set while a volume change is restarting the track, to avoid a loop. */
  volumeChanging: boolean;

  // --- Progress ------------------------------------------------------------
  /** Absolute offset of the current segment within the track. */
  segmentStartOffset: number;
  /** When the current segment started, or null when paused/stopped. */
  segmentStartedAt: number | null;
  progressTimer: NodeJS.Timeout | null;
  uiTimer: NodeJS.Timeout | null;

  // --- Transition state ----------------------------------------------------
  continuous: boolean;
  manualStop: boolean;
  /** True while a track transition is in flight, so only one can run. */
  advancing: boolean;
  /**
   * Bumped by every `connectAndPlay` and by every stop. Each call captures the
   * value it started with and abandons itself if it no longer matches, so two
   * overlapping requests cannot both commit.
   */
  playToken: number;
  /** The next track chosen but not yet started. */
  pendingVideo: any;
  /**
   * The buffered stream belonging to `pendingVideo`, when it came from a
   * preload. Owned by the session until `connectAndPlay` adopts it — if the
   * candidate is dropped instead, this must be killed or the yt-dlp + ffmpeg
   * pair behind it stays alive forever.
   */
  pendingHandle: AudioStreamHandle | null;
  /** Buffered next track, held live and paused to make the boundary instant. */
  preloaded: PreloadedTrack | null;

  // --- Transition timers ---------------------------------------------------
  /** Timer armed to begin the next crossfade, if one is scheduled. */
  crossfadeTimer: NodeJS.Timeout | null;
  /** Timer that starts recording the outgoing track for a crossfade. */
  tapeTimer: NodeJS.Timeout | null;
  /** Timer armed to preload the next track. Cancellable, unlike a bare timeout. */
  preloadTimer: NodeJS.Timeout | null;
  /** Watchdog that aborts a crossfade which produces no audio. */
  crossfadeWatchdog: NodeJS.Timeout | null;
  /** Interval that polls the active stream for stalls. */
  streamWatchdog: NodeJS.Timeout | null;
  /** Timer that fires the next rejoin attempt after a voice failure. */
  rejoinTimer: NodeJS.Timeout | null;
  /** True while a connection loss is being recovered from, so it happens once. */
  recovering: boolean;

  // --- Crossfade internals -------------------------------------------------
  /** True while a crossfade transition is in flight. */
  crossfading: boolean;
  /** Paused copy of the outgoing track, recorded for the crossfade blend. */
  outgoingTape: PassThrough | null;
  /** The handle that owns `outgoingTape`, so it can be detached. */
  outgoingTapeHandle: AudioStreamHandle | null;
  /** The player that was playing before a crossfade swapped the subscription. */
  outgoingPlayer: any;

  // --- Queue / cycle (persisted) ------------------------------------------
  queue: string[];
  playedIds: Set<string>;
  failedIds: Set<string>;
  cycleCount: number;
  cycleStartedAt: number | null;
  sleepDeadline?: number | null;

  // --- Failure counters ----------------------------------------------------
  /** Consecutive "died immediately" retries for the current track. */
  retryCount: number;
  /** Consecutive "died early" retries for the current track. */
  earlyEndRetryCount: number;
  /** Consecutive stall restarts for the current track. */
  deadStreamRestarts: number;


  constructor(guildId: string) {
    this.guildId = guildId;

    // Discord objects
    this.guild = null;
    this.channel = null;
    this.connection = null;
    this.nowPlayingMessage = null;

    // Currently playing
    this.player = null;
    this.resource = null;
    this.activeHandle = null;
    this.current = null;
    this.paused = false;
    this.mode = null;
    this.volume = config.defaultVolume;
    this.interjecting = false;
    this.isLive = false;
    this.volumeChanging = false;

    // Progress
    this.segmentStartOffset = 0;
    this.segmentStartedAt = null;
    this.progressTimer = null;
    this.uiTimer = null;

    // Transition state
    this.continuous = false;
    this.manualStop = false;
    this.advancing = false;
    this.playToken = 0;
    this.pendingVideo = null;
    this.pendingHandle = null;
    this.preloaded = null;

    // Transition timers
    this.crossfadeTimer = null;
    this.tapeTimer = null;
    this.preloadTimer = null;
    this.crossfadeWatchdog = null;
    this.streamWatchdog = null;
    this.rejoinTimer = null;
    this.recovering = false;

    // Crossfade internals
    this.crossfading = false;
    this.outgoingTape = null;
    this.outgoingTapeHandle = null;
    this.outgoingPlayer = null;

    // Queue / cycle
    this.queue = [];
    this.playedIds = new Set();
    this.failedIds = new Set();
    this.cycleCount = 0;
    this.cycleStartedAt = null;
    this.sleepDeadline = null;

    // Failure counters
    this.retryCount = 0;
    this.earlyEndRetryCount = 0;
    this.deadStreamRestarts = 0;
  }
}

export const sessions = new Map();

const MAX_FAILED_IDS = 10_000;

export function addFailedId(session, videoId) {
  session.failedIds.add(videoId);
  if (session.failedIds.size > MAX_FAILED_IDS) {
    const oldest = session.failedIds.values().next().value;
    session.failedIds.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Preload lifecycle
// ---------------------------------------------------------------------------

/**
 * A preload is only usable if it still has a live process and unconsumed audio.
 * Once ffmpeg has closed, or the handle was killed, the buffered PCM is gone.
 */
export function isPreloadUsable(preload: PreloadedTrack | null | undefined): preload is PreloadedTrack {
  if (!preload) return false;
  if (preload.handle.ended) return false;
  if (preload.handle.stream.destroyed) return false;
  return preload.handle.bytesProduced > 0;
}

/** Adopt a preloaded track, clearing the session's reference to it. */
export function takePreload(session): PreloadedTrack | null {
  if (!isPreloadUsable(session.preloaded)) {
    discardPreload(session);
    return null;
  }
  const preload = session.preloaded;
  session.preloaded = null;
  return preload;
}

/** Kill a preload and everything it holds. Safe when there is nothing to do. */
export function discardPreload(session): void {
  const preload = session.preloaded;
  if (!preload) return;
  session.preloaded = null;
  try { preload.handle.kill(); } catch { /* already gone */ }
}

/**
 * Drop the chosen-but-unstarted track, killing any stream buffered for it.
 *
 * `pendingHandle` is set when the candidate came from a preload: the audio is
 * already decoded and its processes are blocked on a full pipe. Anything that
 * abandons a candidate must go through here, or the yt-dlp + ffmpeg pair is
 * orphaned — still running, still tracked, never read again.
 */
export function discardPending(session): void {
  const handle = session.pendingHandle;
  session.pendingHandle = null;
  session.pendingVideo = null;
  if (handle) {
    try { handle.kill(); } catch { /* already gone */ }
  }
}

/**
 * Hand the buffered stream for the pending track to the caller, which becomes
 * responsible for killing it. Returns null when there is nothing buffered, in
 * which case the caller must spawn a fresh stream.
 */
export function takePendingHandle(session): AudioStreamHandle | null {
  const handle = session.pendingHandle;
  session.pendingHandle = null;
  return handle;
}

/** Cancel a scheduled preload so it cannot fire after the session moved on. */
export function clearPreloadTimer(session): void {
  if (session.preloadTimer) {
    clearTimeout(session.preloadTimer);
    session.preloadTimer = null;
  }
}

/** Release the recorded copy of the outgoing track, if any. */
export function releaseTape(session): void {
  const tape = session.outgoingTape;
  session.outgoingTape = null;
  const handle = session.outgoingTapeHandle;
  session.outgoingTapeHandle = null;
  if (!tape) return;
  if (handle) handle.untap(tape);
  else { try { tape.destroy(); } catch { /* already gone */ } }
}

/** Cancel any scheduled crossfade and mark no transition in flight. */
export function clearCrossfade(session): void {
  if (session.crossfadeTimer) {
    clearTimeout(session.crossfadeTimer);
    session.crossfadeTimer = null;
  }
  if (session.tapeTimer) {
    clearTimeout(session.tapeTimer);
    session.tapeTimer = null;
  }
  if (session.crossfadeWatchdog) {
    clearTimeout(session.crossfadeWatchdog);
    session.crossfadeWatchdog = null;
  }
  session.crossfading = false;
}

export function getSession(guildId) {
  let session = sessions.get(guildId);
  if (!session) {
    session = new GuildSession(guildId);
    sessions.set(guildId, session);
  }
  return session;
}

/**
 * Read a session without creating one.
 *
 * `getSession` inserts on first access, which is right for the player and wrong
 * for anything merely reporting on state: a read path that inserts turns any
 * route taking a guild id into a way to grow the map with sessions that hold
 * nothing and are never cleaned up.
 */
export function peekSession(guildId): GuildSession | undefined {
  return sessions.get(guildId);
}

// ---------------------------------------------------------------------------
// State persistence — SQLite (per-guild, no race condition)
// ---------------------------------------------------------------------------

export async function loadAllState() {
  const db = getDb();
  const rows = db.prepare('SELECT guild_id, state FROM session_state').all();
  const result = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.state);
      // Validate critical fields
      if (parsed && typeof parsed === 'object') {
        if (!Array.isArray(parsed.playedIds)) parsed.playedIds = [];
        if (!Array.isArray(parsed.failedIds)) parsed.failedIds = [];
        if (!Array.isArray(parsed.queue)) parsed.queue = [];
        if (typeof parsed.cycleCount !== 'number') parsed.cycleCount = 0;
        result[row.guild_id] = parsed;
      }
    } catch {
      logger.warn(`Corrupted session state for guild ${row.guild_id} — deleting.`);
      db.prepare('DELETE FROM session_state WHERE guild_id = ?').run(row.guild_id);
    }
  }
  return result;
}

export async function saveState(session) {
  try {
    const db = getDb();
    const state = {
      current: session.current,
      mode: session.mode,
      continuous: session.continuous,
      volume: session.volume,
      queue: Array.isArray(session.queue) ? session.queue : [],
      playedIds: session.playedIds instanceof Set ? [...session.playedIds] : Array.isArray(session.playedIds) ? session.playedIds : [],
      failedIds: session.failedIds instanceof Set ? [...session.failedIds] : Array.isArray(session.failedIds) ? session.failedIds : [],
      cycleCount: typeof session.cycleCount === 'number' ? session.cycleCount : 0,
      cycleStartedAt: session.cycleStartedAt || null,
      sleepDeadline: session.sleepDeadline || null,
      savedAt: new Date().toISOString(),
    };
    db.prepare(`
      INSERT OR REPLACE INTO session_state (guild_id, state, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(session.guildId, JSON.stringify(state));
  } catch (err) {
    logger.error('Failed to save state:', err.message);
  }
}

/**
 * Persist only the resume point.
 *
 * `saveState` serialises the whole session, and with a full catalog that is
 * the queue plus every played id — tens of kilobytes rewritten four times a
 * minute per guild just to record a second of progress. This writes one small
 * row instead; the queue blob is only rewritten when the queue itself changes.
 */
export function saveProgress(session, elapsedSeconds: number) {
  try {
    if (!session.current) return;
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO session_progress (guild_id, current, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(session.guildId, JSON.stringify({ ...session.current, progressSeconds: elapsedSeconds }));
  } catch (err) {
    logger.debug('Failed to save progress:', err.message);
  }
}

/** The last known resume point for a guild, or null if nothing was recorded. */
export function loadProgress(guildId): any | null {
  try {
    const row = getDb().prepare('SELECT current FROM session_progress WHERE guild_id = ?').get(guildId) as any;
    return row?.current ? JSON.parse(row.current) : null;
  } catch {
    return null;
  }
}

export async function restoreLastVideo(guildId) {
  const saved = (await loadAllState())[guildId];
  if (!saved) return null;
  const session = getSession(guildId);
  // The progress table is written far more often than the state blob, so it
  // holds the fresher resume point whenever the two disagree.
  const progressed = loadProgress(guildId);
  session.current = (progressed?.videoId && progressed.videoId === saved.current?.videoId)
    ? progressed
    : (saved.current || null);
  session.volume = saved.volume ?? config.defaultVolume;
  if (Array.isArray(saved.playedIds)) session.playedIds = new Set(saved.playedIds);
  if (Array.isArray(saved.failedIds)) session.failedIds = new Set(saved.failedIds);
  if (Array.isArray(saved.queue)) session.queue = saved.queue;
  if (typeof saved.cycleCount === 'number') session.cycleCount = saved.cycleCount;
  if (saved.cycleStartedAt) session.cycleStartedAt = saved.cycleStartedAt;
  if (saved.sleepDeadline) session.sleepDeadline = saved.sleepDeadline;

  if (session.queue.length === 0 && session.playedIds.size > 0) {
    try {
      const catalog = await getVideos();
      await migrateSessionToQueue(session, catalog);
    } catch (err) {
      logger.warn('Failed to migrate session queue on restore:', err.message);
    }
  }

  return session.current;
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

export function getElapsedSeconds(session) {
  const raw = session.segmentStartedAt == null
    ? (session.current?.progressSeconds || 0)
    : session.segmentStartOffset + (Date.now() - session.segmentStartedAt) / 1000;

  // Progress is wall-clock, so an outage or a long pause inflates it without
  // any audio having been played. Left unclamped it can exceed the duration,
  // which makes the resume point land past the end of the track: ffmpeg emits
  // nothing, the stream-start timeout fires, and a perfectly good video is
  // written off as broken after three attempts.
  const duration = session.current?.durationSeconds;
  if (duration && duration > 0 && raw > duration) return duration;
  return raw;
}

export function freezeProgress(session) {
  if (!session.current) return;
  const elapsed = Math.max(0, Math.floor(getElapsedSeconds(session)));
  session.current = { ...session.current, progressSeconds: elapsed };
  session.segmentStartedAt = null;
}

export function startProgressAutosave(session) {
  stopProgressAutosave(session);
  let lastSaved = -1;
  session.progressTimer = setInterval(() => {
    if (!session.current || session.segmentStartedAt == null) return;
    const elapsed = Math.max(0, Math.floor(getElapsedSeconds(session)));
    if (elapsed === lastSaved) return;
    lastSaved = elapsed;
    saveProgress(session, elapsed);
  }, PROGRESS_AUTOSAVE_MS);
}

export function stopProgressAutosave(session) {
  if (session.progressTimer) {
    clearInterval(session.progressTimer);
    session.progressTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Shuffle-bag queue management
// ---------------------------------------------------------------------------

const CYCLE_OVERLAP_K = 20;

/** Fisher–Yates shuffle (returns new array). */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build a fresh shuffled queue from the catalog, excluding failed IDs.
 * Guarantees no near-repeat across the cycle boundary by checking
 * the first K entries against the previous cycle's last K played entries.
 */
export function buildNewQueue(catalog, failedIds = [], previousCyclePlayed = []) {
  const exclude = new Set(failedIds);
  const pool = catalog.filter(v => !exclude.has(v.videoId));
  const q = shuffle(pool).map(v => v.videoId);

  if (previousCyclePlayed.length > 0 && q.length > 0) {
    const prevTail = new Set(previousCyclePlayed.slice(-CYCLE_OVERLAP_K));
    const headSlice = q.slice(0, CYCLE_OVERLAP_K);
    const overlap = headSlice.filter(id => prevTail.has(id));
    if (overlap.length > 0) {
      for (const bad of overlap) {
        const headIdx = q.indexOf(bad);
        const midIdx = Math.floor(q.length / 2 + Math.random() * (q.length / 2));
        [q[headIdx], q[midIdx]] = [q[midIdx], q[headIdx]];
      }
    }
  }

  return q;
}

/**
 * Pop the next videoId from the persisted queue. If the queue is empty,
 * reshuffle the full catalog (cycle boundary).
 * Returns { videoId, newCycle }.
 */
export function popFromQueue(session, catalog) {
  if (session.queue.length === 0) {
    const prevPlayed = [...session.playedIds];
    session.queue = buildNewQueue(catalog, [...session.failedIds], prevPlayed);
    session.playedIds.clear();
    session.failedIds.clear();
    session.cycleCount += 1;
    session.cycleStartedAt = new Date().toISOString();
    saveState(session);
    return { videoId: session.queue.shift(), newCycle: true };
  }
  return { videoId: session.queue.shift(), newCycle: false };
}

/**
 * Migration: convert old playedIds-based state to new queue-based state.
 * Run once on first boot after deploy. If session already has a queue,
 * this is a no-op.
 */
export async function migrateSessionToQueue(session, catalog) {
  if (session.queue.length > 0) return false;
  if (session.playedIds.size === 0 && catalog.length > 0) {
    session.queue = buildNewQueue(catalog, [...session.failedIds]);
    if (!session.cycleCount || session.cycleCount < 1) session.cycleCount = 1;
    session.cycleStartedAt = new Date().toISOString();
    await saveState(session);
    return true;
  }
  const exclude = new Set([...session.playedIds, ...session.failedIds]);
  const remaining = catalog.filter(v => !exclude.has(v.videoId));
  session.queue = shuffle(remaining);
  if (!session.cycleCount || session.cycleCount < 1) session.cycleCount = 1;
  session.cycleStartedAt = new Date().toISOString();
  await saveState(session);
  return true;
}

/**
 * §2.6 Sync the persisted queue with a fresh catalog:
 * - Insert new videos (in catalog but not in queue or playedIds) at random positions.
 * - Remove stale videos (in queue but no longer in catalog — deleted/privated).
 * Returns true if the queue was modified.
 */
export function syncQueueWithCatalog(session, catalog) {
  if (session.queue.length === 0) return false;

  const catalogIds = new Set(catalog.map(v => v.videoId));
  const playedOrFailed = new Set([...session.playedIds, ...session.failedIds]);

  let changed = false;

  // 1. Remove stale queued videos no longer in catalog
  const before = session.queue.length;
  session.queue = session.queue.filter(id => catalogIds.has(id));
  if (session.queue.length !== before) changed = true;

  // 2. Find new videos: in catalog but not in queue, playedIds, or failedIds
  const queuedSet = new Set(session.queue);
  const newVideos = catalog.filter(v => !queuedSet.has(v.videoId) && !playedOrFailed.has(v.videoId));

  // 3. Insert each new video at a random position in the queue
  for (const v of newVideos) {
    const pos = Math.floor(Math.random() * (session.queue.length + 1));
    session.queue.splice(pos, 0, v.videoId);
    changed = true;
  }

  if (changed) saveState(session);
  return changed;
}
