/**
 * Lightweight play-count persistence (async, non-blocking).
 */

import { writeFile, readFile, copyFile, access } from 'node:fs/promises';
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

async function saveJson(path, data) {
  try {
    const now = Date.now();
    if (now - lastBackupAt > BACKUP_INTERVAL_MS) {
      if (await fileExists(path)) {
        try { await copyFile(path, path + '.bak'); } catch {}
      }
      lastBackupAt = now;
    }
    await writeFile(path, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(`Failed to write ${path}:`, err.message);
  }
}

/** Load all play counts. */
export async function loadPlays() {
  return loadJson(PLAYS_FILE);
}

/** Bump a video's play count. Called once per track start (see player.js). */
export async function recordPlay(video) {
  if (!video?.videoId) return;
  const all = await loadJson(PLAYS_FILE);
  const existing = all[video.videoId] || { title: video.title, url: video.url, count: 0 };
  all[video.videoId] = {
    title: video.title,
    url: video.url,
    count: existing.count + 1,
    lastPlayedAt: new Date().toISOString(),
  };
  await saveJson(PLAYS_FILE, all);

  // Append to history
  const history = await loadArray(HISTORY_FILE);
  history.unshift({
    videoId: video.videoId,
    title: video.title,
    url: video.url,
    playedAt: new Date().toISOString(),
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  await saveJson(HISTORY_FILE, history);
}

/** Get recent play history (last N tracks). */
export async function getPlayHistory(limit = 20) {
  const history = await loadArray(HISTORY_FILE);
  return history.slice(0, limit);
}
