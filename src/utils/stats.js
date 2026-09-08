/**
 * Lightweight play-count persistence.
 */

import { writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('stats');

const PLAYS_FILE = join(process.cwd(), 'play-counts.json');

function loadJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    logger.error(`Failed to read ${path}:`, err.message);
    return {};
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
}
