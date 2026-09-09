/**
 * Lightweight play-count persistence (async, non-blocking).
 * Unified stats: per-video play count, completion, and failure tracking.
 */

import { writeFile, readFile, copyFile, access, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('stats');

const PLAYS_FILE = join(process.cwd(), 'play-counts.json');
const HISTORY_FILE = join(process.cwd(), 'play-history.json');
const MAX_HISTORY = 50;

let lastBackupAt = 0;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function loadJson(path) {
  if (!(await fileExists(path))) return {};
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    logger.error(`Failed to read ${path}:`, err.message);
    return {};
  }
}

async function loadArray(path) {
  if (!(await fileExists(path))) return [];
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return [];
  }
}

async function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

async function saveJson(path, data) {
  try {
    const now = Date.now();
    if (now - lastBackupAt > BACKUP_INTERVAL_MS) {
      if (await fileExists(path)) {
        try { await copyFile(path, path + '.bak'); } catch {}
      }
      lastBackupAt = now;
    }
    await atomicWriteJson(path, data);
  } catch (err) {
    logger.error(`Failed to write ${path}:`, err.message);
  }
}

/** Load all play counts. */
export async function loadPlays() {
  return loadJson(PLAYS_FILE);
}

/**
 * Record a play event. Called once per track start, and optionally
 * again on completion/failure to update lastCompleted and failCount.
 *
 * @param {object} video - { videoId, title, url }
 * @param {object} [opts]
 * @param {boolean} [opts.completed] - true if the track played to the end
 * @param {boolean} [opts.failed] - true if the track failed (broken URL etc.)
 */
export async function recordPlay(video, opts = {}) {
  if (!video?.videoId) return;
  const all = await loadJson(PLAYS_FILE);
  const now = new Date().toISOString();
  const existing = all[video.videoId] || {
    title: video.title,
    url: video.url,
    playCount: 0,
    firstPlayedAt: now,
    lastPlayedAt: now,
    lastCompleted: false,
    failCount: 0,
  };

  if (opts.completed !== undefined) existing.lastCompleted = opts.completed;
  if (opts.failed) existing.failCount = (existing.failCount || 0) + 1;
  if (!opts.completed && !opts.failed) {
    existing.playCount = (existing.playCount || 0) + 1;
    existing.lastPlayedAt = now;
    if (!existing.firstPlayedAt) existing.firstPlayedAt = now;
  }

  all[video.videoId] = existing;
  await saveJson(PLAYS_FILE, all);

  // Append to history (only on track start, not on completion/failure updates)
  if (!opts.completed && !opts.failed) {
    const history = await loadArray(HISTORY_FILE);
    history.unshift({
      videoId: video.videoId,
      title: video.title,
      url: video.url,
      playedAt: now,
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await saveJson(HISTORY_FILE, history);
  }
}

/** Get recent play history (last N tracks). */
export async function getPlayHistory(limit = 20) {
  const history = await loadArray(HISTORY_FILE);
  return history.slice(0, limit);
}
