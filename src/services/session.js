/**
 * Session management — GuildSession class, state persistence, progress tracking.
 */

import { writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
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
// State persistence
// ---------------------------------------------------------------------------

export function loadAllState() {
  if (!existsSync(STATE_FILE)) {
    if (existsSync(STATE_FILE + '.bak')) {
      try { return JSON.parse(readFileSync(STATE_FILE + '.bak', 'utf-8')); } catch {}
    }
    return {};
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    logger.error('Failed to load state file, trying backup:', err.message);
    if (existsSync(STATE_FILE + '.bak')) {
      try { return JSON.parse(readFileSync(STATE_FILE + '.bak', 'utf-8')); } catch {}
    }
    return {};
  }
}

export function saveState(session) {
  try {
    const all = loadAllState();
    all[session.guildId] = {
      current: session.current,
      mode: session.mode,
      continuous: session.continuous,
      volume: session.volume,
      savedAt: new Date().toISOString(),
    };
    if (existsSync(STATE_FILE)) {
      try { copyFileSync(STATE_FILE, STATE_FILE + '.bak'); } catch {}
    }
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    logger.error('Failed to save state:', err.message);
  }
}

export function restoreLastVideo(guildId) {
  const saved = loadAllState()[guildId];
  if (!saved) return null;
  const session = getSession(guildId);
  session.current = saved.current || null;
  session.volume = saved.volume ?? config.defaultVolume;
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
