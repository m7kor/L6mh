/**
 * Session management — GuildSession class, state persistence, progress tracking.
 * All file I/O is async (non-blocking) to avoid hiccups on slow storage.
 */

import { writeFile, readFile, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('audio');
const STATE_FILE = join(process.cwd(), 'playback-state.json');
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
  }
}

export const sessions = new Map();

const RECENT_HISTORY_SIZE = 20;

export function getSession(guildId) {
  let session = sessions.get(guildId);
  if (!session) {
    session = new GuildSession(guildId);
    sessions.set(guildId, session);
  }
  return session;
}

// ---------------------------------------------------------------------------
// State persistence (async, debounced backups)
// ---------------------------------------------------------------------------

let lastBackupAt = 0;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function loadAllState() {
  if (!(await fileExists(STATE_FILE))) {
    if (await fileExists(STATE_FILE + '.bak')) {
      try { return JSON.parse(await readFile(STATE_FILE + '.bak', 'utf-8')); } catch {}
    }
    return {};
  }
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf-8'));
  } catch (err) {
    logger.error('Failed to load state file, trying backup:', err.message);
    if (await fileExists(STATE_FILE + '.bak')) {
      try { return JSON.parse(await readFile(STATE_FILE + '.bak', 'utf-8')); } catch {}
    }
    return {};
  }
}

export async function saveState(session) {
  try {
    const all = await loadAllState();
    all[session.guildId] = {
      current: session.current,
      mode: session.mode,
      continuous: session.continuous,
      volume: session.volume,
      playedIds: [...session.playedIds],
      failedIds: [...session.failedIds],
      savedAt: new Date().toISOString(),
    };
    const now = Date.now();
    if (now - lastBackupAt > BACKUP_INTERVAL_MS) {
      if (await fileExists(STATE_FILE)) {
        try { await copyFile(STATE_FILE, STATE_FILE + '.bak'); } catch {}
      }
      lastBackupAt = now;
    }
    await writeFile(STATE_FILE, JSON.stringify(all, null, 2));
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
