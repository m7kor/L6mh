/**
 * controls.js — واجهة التحكم العامة بالمشغل.
 *
 * يحتوي على: stop, skip, pause, resume, volume, getQueue, getSessionInfo, getAllSessions.
 * منفصل تماماً عن منطق التشغيل (engine.js) لسهولة الاختبار والصيانة.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../../utils/logger.js';
import {
  getSession, peekSession, sessions, GuildSession,
  saveState,
  getElapsedSeconds,
  freezeProgress,
  startProgressAutosave,
  stopProgressAutosave,
  clearCrossfade,
  discardPreload,
  discardPending,
  clearPreloadTimer,
  releaseTape,
} from '../session.js';
import { killProcesses } from '../streaming.js';
import { clearNowPlayingMessage, stopNowPlayingRefresh, triggerUiUpdate } from './ui-updater.js';
import { getCachedTitleMap } from '../youtube.js';
import { inferPlaybackState } from '../../utils/playback-state.js';

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
  session.crossfading = false;
  // Cancel any in-flight `connectAndPlay`. It can be up to 60s into a voice
  // connection and 45s into a stream spawn at this point, and it commits
  // unconditionally once it gets there — so without this, a /stop issued while
  // a track was still starting would be silently overwritten by it.
  session.playToken += 1;


  freezeProgress(session);
  stopProgressAutosave(session);

  // Cancel any scheduled transition and drop the buffered next track, so
  // stopping never leaves an ffmpeg/yt-dlp pair alive.
  clearCrossfade(session);
  clearPreloadTimer(session);
  discardPreload(session);
  discardPending(session);
  releaseTape(session);

  // The periodic embed refresh has to stop on *any* stop, not just a manual
  // one. A non-manual stop leaves the message on screen, so the reference
  // stays — but a running timer would keep editing a message about a track
  // that is no longer playing, twice a minute, indefinitely.
  if (manual) {
    clearNowPlayingMessage(session);
  } else {
    stopNowPlayingRefresh(session);
  }

  if (session.rejoinTimer) {
    clearTimeout(session.rejoinTimer);
    session.rejoinTimer = null;
  }

  // The player that a crossfade left behind is no longer subscribed, but still
  // holds a resource — stop it so its stream is released.
  if (session.outgoingPlayer) {
    try { session.outgoingPlayer.stop(true); } catch { /* already gone */ }
    session.outgoingPlayer = null;
  }
  if (session.streamWatchdog) {
    clearInterval(session.streamWatchdog);
    session.streamWatchdog = null;
  }

  const player = session.player;
  session.player = null;
  if (player) {
    try { player.stop(true); } catch { /* already gone */ }
  }

  if (manual) {
    const conn = session.connection;
    session.connection = null;
    if (conn) {
      try { conn.destroy(); } catch { /* already gone */ }
    }
  }

  killProcesses(session);
  await saveState(session);
  playerEvents.emit('trackChange', { guildId, video: null, paused: false });
  logger.info(`[${guildId}] Stopped playback${manual ? ' and disconnected.' : '.'}`);
}

export async function stopAllSessions() {
  const tasks = [...sessions.keys()].map(guildId => stopPlayback(guildId).catch(() => {}));
  await Promise.allSettled(tasks);
}

// ---------------------------------------------------------------------------
// Skip
// ---------------------------------------------------------------------------

export function skipTrack(guildId) {
  const session = getSession(guildId);
  if (!session.player) return;
  // A pending crossfade would otherwise fire mid-skip and start the track the
  // user just skipped past.
  clearCrossfade(session);
  killProcesses(session);
  if (session.outgoingPlayer) {
    try { session.outgoingPlayer.stop(true); } catch { /* already gone */ }
    session.outgoingPlayer = null;
  }
  try { session.player.stop(true); } catch { /* already gone */ }
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
// Getters — read-only, so they must not create a session as a side effect
// ---------------------------------------------------------------------------

/**
 * A throwaway stand-in for a guild with no session.
 *
 * Fresh per call rather than shared: it is a real mutable object, and a shared
 * instance would let one guild's read corrupt another's.
 */
function emptySession(): GuildSession {
  return new GuildSession('unknown');
}

export function getQueue(guildId) {
  return (peekSession(guildId) || emptySession()).queue || [];
}

export function getSessionInfo(guildId) {
  const session = peekSession(guildId) || emptySession();
  return {
    playbackState:   inferPlaybackState(session),
    current:         session.current,
    mode:            session.mode,
    continuous:      session.continuous,
    volume:          (session.volume || 100) / 100,
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
      playbackState:   inferPlaybackState(session),
      guildName:       session.guild?.name || guildId,
      channelName:     session.channel?.name || null,
      title:           session.current?.title      || null,
      videoId:         session.current?.videoId    || null,
      url:             session.current?.url        || null,
      thumbnail:       session.current?.thumbnail  || null,
      mode:            session.mode,
      volume:          (session.volume || 100) / 100,
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
