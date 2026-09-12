/**
 * controls.js — واجهة التحكم العامة بالمشغل.
 *
 * يحتوي على: stop, skip, pause, resume, volume, getQueue, getSessionInfo, getAllSessions.
 * منفصل تماماً عن منطق التشغيل (engine.js) لسهولة الاختبار والصيانة.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../../utils/logger.js';
import {
  getSession, sessions,
  saveState,
  getElapsedSeconds,
  freezeProgress,
  startProgressAutosave,
  stopProgressAutosave,
} from '../session.js';
import { killProcesses } from '../streaming.js';
import { clearNowPlayingMessage, triggerUiUpdate } from './ui-updater.js';
import { notify } from '../../utils/webhook.js';
import { getCachedTitleMap } from '../youtube.js';

const logger = createLogger('audio');

/** حدث يُطلق عند تغيير المقطع أو حالة التشغيل — يُستمع له في index.js */
export const playerEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export async function stopPlayback(guildId, { manual = true } = {}) {
  const session = getSession(guildId);
  if (session.manualStop && manual) return;
  session.continuous  = false;
  session.manualStop  = manual;
  session.queue       = [];
  session.paused      = false;

  freezeProgress(session);
  stopProgressAutosave(session);

  if (manual) {
    clearNowPlayingMessage(session);
  }

  const player = session.player;
  session.player = null;
  if (player) {
    try { player.stop(true); } catch {}
  }

  if (manual) {
    const conn = session.connection;
    session.connection = null;
    if (conn) {
      try { conn.destroy(); } catch {}
    }
  }

  killProcesses(session);
  await saveState(session);
  playerEvents.emit('trackChange', { guildId, video: null, paused: false });
  logger.info(`[${guildId}] Stopped playback${manual ? ' and disconnected.' : '.'}`);
}

export async function stopAllSessions() {
  for (const guildId of sessions.keys()) {
    await stopPlayback(guildId);
  }
}

// ---------------------------------------------------------------------------
// Skip
// ---------------------------------------------------------------------------

export function skipTrack(guildId) {
  const session = getSession(guildId);
  if (!session.player) return;
  killProcesses(session);
  try { session.player.stop(true); } catch {}
  logger.info(`[${guildId}] Track skipped.`);
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/**
 * @param {string} guildId
 * @param {number} volume - 0..200
 * @param {Function} connectAndPlayFn - مُمرَّرة من engine لتجنب الاستيراد الدائري
 */
export async function setVolume(guildId, volume, connectAndPlayFn) {
  const session = getSession(guildId);
  const clamped = Math.max(0, Math.min(200, volume));
  session.volume = clamped;
  await saveState(session);

  if (session.current && session.connection && session.guild && session.channel && !session.volumeChanging) {
    session.volumeChanging = true;
    try {
      const elapsed = Math.floor(getElapsedSeconds(session));
      const video   = { ...session.current, progressSeconds: elapsed };
      await connectAndPlayFn(session.guild, session.channel, video, { countPlay: false });
    } catch (err) {
      logger.warn(`[${guildId}] Volume change restart failed:`, err.message);
    } finally {
      session.volumeChanging = false;
    }
  }

  return clamped;
}

// ---------------------------------------------------------------------------
// Pause / Resume
// ---------------------------------------------------------------------------

export async function pausePlayback(guildId) {
  const session = getSession(guildId);
  if (!session.player || !session.current) return false;
  session.player.pause();
  session.paused = true;
  freezeProgress(session);
  await saveState(session);
  playerEvents.emit('trackChange', { guildId, video: session.current, paused: true });
  triggerUiUpdate(session).catch(() => {});
  logger.info(`[${guildId}] Paused playback.`);
  return true;
}

export async function resumePlayback(guildId) {
  const session = getSession(guildId);
  if (!session.player || !session.current) return false;
  session.player.unpause();
  session.paused = false;
  startProgressAutosave(session);
  await saveState(session);
  playerEvents.emit('trackChange', { guildId, video: session.current, paused: false });
  triggerUiUpdate(session).catch(() => {});
  logger.info(`[${guildId}] Resumed playback.`);
  return true;
}

// ---------------------------------------------------------------------------
// Queue Management
// ---------------------------------------------------------------------------

export async function removeFromQueue(guildId: string, index: number) {
  const session = getSession(guildId);
  if (index >= 0 && index < session.queue.length) {
    session.queue.splice(index, 1);
    await saveState(session);
    return true;
  }
  return false;
}

export async function moveToTopQueue(guildId: string, index: number) {
  const session = getSession(guildId);
  if (index > 0 && index < session.queue.length) {
    const item = session.queue.splice(index, 1)[0];
    session.queue.unshift(item);
    await saveState(session);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getQueue(guildId) {
  const session = getSession(guildId);
  return session.queue || [];
}

export function getSessionInfo(guildId) {
  const session = getSession(guildId);
  return {
    current:         session.current,
    mode:            session.mode,
    continuous:      session.continuous,
    volume:          session.volume,
    paused:          session.paused,
    connected:       Boolean(session.connection),
    elapsedSeconds:  session.current ? getElapsedSeconds(session) : 0,
    queueCount:      session.queue.length,
    videoId:         session.current?.videoId  || null,
    videoUrl:        session.current?.url       || null,
    thumbnail:       session.current?.thumbnail || null,
    durationSeconds: session.current?.durationSeconds || null,
    isLive:          session.isLive || false,
  };
}

export function getAllSessions() {
  const result = [];
  for (const [guildId, session] of sessions) {
    if (!session.connection && !session.current) continue;
    result.push({
      guildId,
      guildName:       session.guild?.name || guildId,
      channelName:     session.channel?.name || null,
      title:           session.current?.title      || null,
      videoId:         session.current?.videoId    || null,
      url:             session.current?.url        || null,
      thumbnail:       session.current?.thumbnail  || null,
      mode:            session.mode,
      volume:          session.volume,
      paused:          session.paused,
      connected:       Boolean(session.connection),
      continuous:      session.continuous,
      queueCount:      session.queue.length,
      elapsedSeconds:  session.current ? getElapsedSeconds(session) : 0,
      durationSeconds: session.current?.durationSeconds || null,
      playedCount:     session.playedIds.size,
      cycleCount:      session.cycleCount,
      isLive:          session.isLive || false,
      queue:           (() => {
        const titleMap = getCachedTitleMap();
        return session.queue.slice(0, 50).map((vidId, idx) => {
          const video = session.current?.videoId === vidId ? session.current : null;
          return {
            videoId: vidId,
            title: video?.title || titleMap.get(vidId) || vidId,
            thumbnail: video?.thumbnail || null,
            position: idx + 1,
          };
        });
      })(),
    });
  }
  return result;
}
