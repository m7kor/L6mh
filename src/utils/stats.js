/**
 * Lightweight play-count persistence.
 */

import { writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('stats');

const PLAYS_FILE = join(process.cwd(), 'play-counts.json');
const HISTORY_FILE = join(process.cwd(), 'play-history.json');
const MAX_HISTORY = 50;

function loadJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    logger.error(`Failed to read ${path}:`, err.message);
    return {};
  }
}

function loadArray(path) {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function saveJson(path, data) {
  try {
    if (existsSync(path)) {
      try { copyFileSync(path, path + '.bak'); } catch {}
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(`Failed to write ${path}:`, err.message);
  }
}

/** Load all play counts. */
export function loadPlays() {
  return loadJson(PLAYS_FILE);
}

/** Bump a video's play count. Called once per track start (see player.js). */
export function recordPlay(video) {
  if (!video?.videoId) return;
  const all = loadJson(PLAYS_FILE);
  const existing = all[video.videoId] || { title: video.title, url: video.url, count: 0 };
  all[video.videoId] = {
    title: video.title,
    url: video.url,
    count: existing.count + 1,
    lastPlayedAt: new Date().toISOString(),
  };
  saveJson(PLAYS_FILE, all);

  // Append to history
  const history = loadArray(HISTORY_FILE);
  history.unshift({
    videoId: video.videoId,
    title: video.title,
    url: video.url,
    playedAt: new Date().toISOString(),
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  saveJson(HISTORY_FILE, history);
}

/** Get recent play history (last N tracks). */
export function getPlayHistory(limit = 20) {
  const history = loadArray(HISTORY_FILE);
  return history.slice(0, limit);
}
