/**
 * Session management — GuildSession class, state persistence, progress tracking.
 * State is persisted per-guild in SQLite (session_state table) — no race conditions.
 * better-sqlite3 is synchronous, so atomicity is guaranteed at the DB level.
 */

import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getVideos } from './youtube.js';
import { getDb } from '../utils/database.js';

const logger = createLogger('audio');
const PROGRESS_AUTOSAVE_MS = 15_000;

export class GuildSession {
  constructor(guildId) {
    this.guildId = guildId;
    this.connection = null;
    this.player = null;
    this.resource = null;
    this.mode = null;
    this.continuous = false;
    this.volume = config.defaultVolume;
    this.paused = false;
    this.queue = [];
    this.recentIds = [];
    this.playedIds = new Set();
    this.failedIds = new Set();
    this.current = null;
    this.manualStop = false;
    this.advancing = false;
    this.segmentStartOffset = 0;
    this.segmentStartedAt = null;
    this.progressTimer = null;
    this.uiTimer = null;
    this.resolveProcess = null;
    this.ffmpegProcess = null;
    this.nowPlayingMessage = null;
    this.interjecting = false;
    this.guild = null;
    this.channel = null;
    this.preloaded = null;
    this.volumeChanging = false;
    this.stallTimeout = null;
    this.keepAliveTimer = null;
    this.cycleCount = 0;
    this.cycleStartedAt = null;
  }
}

export const sessions = new Map();

const RECENT_HISTORY_SIZE = 20;
const MAX_FAILED_IDS = 200;

export function addFailedId(session, videoId) {
  session.failedIds.add(videoId);
  if (session.failedIds.size > MAX_FAILED_IDS) {
    const oldest = session.failedIds.values().next().value;
    session.failedIds.delete(oldest);
  }
}

export function getSession(guildId) {
  let session = sessions.get(guildId);
  if (!session) {
    session = new GuildSession(guildId);
    sessions.set(guildId, session);
  }
  return session;
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
      result[row.guild_id] = JSON.parse(row.state);
    } catch {}
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
      queue: session.queue,
      playedIds: [...session.playedIds],
      failedIds: [...session.failedIds],
      cycleCount: session.cycleCount,
      cycleStartedAt: session.cycleStartedAt,
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

export async function restoreLastVideo(guildId) {
  const saved = (await loadAllState())[guildId];
  if (!saved) return null;
  const session = getSession(guildId);
  session.current = saved.current || null;
  session.volume = saved.volume ?? config.defaultVolume;
  if (Array.isArray(saved.playedIds)) session.playedIds = new Set(saved.playedIds);
  if (Array.isArray(saved.failedIds)) session.failedIds = new Set(saved.failedIds);
  if (Array.isArray(saved.queue)) session.queue = saved.queue;
  if (typeof saved.cycleCount === 'number') session.cycleCount = saved.cycleCount;
  if (saved.cycleStartedAt) session.cycleStartedAt = saved.cycleStartedAt;

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
  if (session.segmentStartedAt == null) {
    return session.current?.progressSeconds || 0;
  }
  const elapsedSinceSegmentStart = (Date.now() - session.segmentStartedAt) / 1000;
  return session.segmentStartOffset + elapsedSinceSegmentStart;
}

export function freezeProgress(session) {
  if (!session.current) return;
  const elapsed = Math.max(0, Math.floor(getElapsedSeconds(session)));
  session.current = { ...session.current, progressSeconds: elapsed };
  session.segmentStartedAt = null;
}

export function startProgressAutosave(session) {
  stopProgressAutosave(session);
  session.progressTimer = setInterval(() => {
    if (!session.current || session.segmentStartedAt == null) return;
    const elapsed = Math.max(0, Math.floor(getElapsedSeconds(session)));
    saveState({ ...session, current: { ...session.current, progressSeconds: elapsed } });
  }, PROGRESS_AUTOSAVE_MS);
}

export function stopProgressAutosave(session) {
  if (session.progressTimer) {
    clearInterval(session.progressTimer);
    session.progressTimer = null;
  }
}

export function trackRecent(session, videoId) {
  if (!videoId) return;
  session.recentIds.push(videoId);
  if (session.recentIds.length > RECENT_HISTORY_SIZE) session.recentIds.shift();
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
  let q = shuffle(pool).map(v => v.videoId);

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
