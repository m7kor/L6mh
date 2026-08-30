/**
 * Lightweight persistence for two fan-facing features:
 *  - per-user favorites (`/favorite`, `/favorites`)
 *  - a play-count leaderboard across the whole radio (`/top`)
 *
 * Same pattern as playback-state.json in services/player.js: a single JSON
 * file, read-modify-written on each change. Traffic here is command-rate,
 * not audio-rate, so there's no need for anything fancier.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('stats');

const FAVORITES_FILE = join(process.cwd(), 'favorites.json');
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
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(`Failed to write ${path}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Favorites — keyed by userId, each an array of { videoId, title, url, savedAt }
// ---------------------------------------------------------------------------

export function addFavorite(userId, video) {
  const all = loadJson(FAVORITES_FILE);
  const list = all[userId] || [];

  if (list.some((v) => v.videoId === video.videoId)) {
    return { added: false, list };
  }

  list.unshift({
    videoId: video.videoId,
    title: video.title,
    url: video.url,
    savedAt: new Date().toISOString(),
  });
  all[userId] = list;
  saveJson(FAVORITES_FILE, all);
  return { added: true, list };
}

export function getFavorites(userId) {
  const all = loadJson(FAVORITES_FILE);
  return all[userId] || [];
}

export function removeFavorite(userId, videoId) {
  const all = loadJson(FAVORITES_FILE);
  const list = all[userId] || [];
  const next = list.filter((v) => v.videoId !== videoId);
  all[userId] = next;
  saveJson(FAVORITES_FILE, all);
  return next;
}

// ---------------------------------------------------------------------------
// Play-count leaderboard — keyed by videoId
// ---------------------------------------------------------------------------

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

/** Top N most-played videos, most-played first. */
export function getTopPlayed(limit = 10) {
  const all = loadJson(PLAYS_FILE);
  return Object.entries(all)
    .map(([videoId, data]) => ({ videoId, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
