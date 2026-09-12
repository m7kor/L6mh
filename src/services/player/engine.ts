// @ts-nocheck
/**
 * engine.js — محرك الصوت الأساسي.
 *
 * المسؤوليات:
 *   - الاتصال بقنوات الصوت وإدارة VoiceConnection
 *   - إنشاء AudioPlayer وتشغيل البث
 *   - الانتقال التلقائي بين المقاطع (onTrackFinished)
 *   - إعادة الانضمام بعد انقطاع الشبكة (rejoinAndResume)
 *   - Preloading للمقطع التالي
 *   - playRandom, playLatest, playVideo, resume
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { createLogger } from '../../utils/logger.js';
import { notify } from '../../utils/webhook.js';
import { recordPlay } from '../../utils/stats.js';
import { logDashboardError } from '../../utils/status-page.js';
import { getVideoDetails, getVideos, getLatestVideo } from '../youtube.js';
import { getCookieArgs } from '../cookies.js';
import { createAudioStream, killProcesses, preValidateVideo, isLiveStream, getActiveProvider } from '../streaming.js';
import {
  getSession, saveState,
  getElapsedSeconds, freezeProgress,
  startProgressAutosave, stopProgressAutosave,
  popFromQueue, migrateSessionToQueue, syncQueueWithCatalog,
  restoreLastVideo, addFailedId,
} from '../session.js';
import { playerEvents, stopPlayback } from './controls.js';
import { playRandomJingle } from './jingles.js';
import { triggerUiUpdate } from './ui-updater.js';
import { spawn } from 'node:child_process';
import { NOTIFY } from '../../lang.js';

const logger = createLogger('audio');

const RETRY_BASE_DELAY_MS  = 5_000;
const RETRY_MAX_DELAY_MS   = 60_000;
const RECONNECT_DELAY_MS   = 10_000;
const PRELOAD_THRESHOLD_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function jitteredDelay(baseMs, attempt) {
  const delay  = Math.min(baseMs * attempt, RETRY_MAX_DELAY_MS);
  const jitter = delay * (0.8 + Math.random() * 0.4);
  return Math.floor(jitter);
}

/**
 * Dynamic timeout based on video duration.
 * Short videos get shorter timeouts, long videos get longer ones.
 * @param {number|null} durationSeconds - video duration in seconds
 * @param {number} pct - percentage of duration (e.g. 0.01 = 1%)
 * @param {number} minMs - minimum timeout in ms
 * @param {number} maxMs - maximum timeout in ms
 */
function dynamicTimeout(durationSeconds, pct, minMs, maxMs) {
  if (!durationSeconds || durationSeconds <= 0) return minMs;
  const computed = Math.floor(durationSeconds * 1000 * pct);
  return Math.max(minMs, Math.min(maxMs, computed));
}

async function enrichWithDetails(video) {
  if (!video?.videoId) return video;
  const details = await getVideoDetails(video.videoId).catch(() => null);
  if (!details) return video;
  return {
    ...video,
    durationSeconds: details.durationSeconds,
    thumbnail:       video.thumbnail || details.thumbnail,
    viewCount:       details.viewCount,
    publishedAt:     details.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Preload — جهّز المقطع التالي في الخلفية
// ---------------------------------------------------------------------------

async function preloadNextTrack(session) {
  if (session.preloaded) return;
  try {
    const nextId = session.queue[0];
    if (!nextId) return;
    const catalog = await getVideos();
    syncQueueWithCatalog(session, catalog);
    const next = catalog.find((v) => v.videoId === nextId);
    if (!next?.url) return;

    const ytDlpArgs = [
      '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '--no-progress',
      '-o', '-', '--no-part',
      ...getCookieArgs(),
      next.url,
    ];
    const provider = getActiveProvider();
    if (provider && provider !== 'none') {
      ytDlpArgs.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${provider}`);
    }
    const proc = spawn('yt-dlp', ytDlpArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stderr.on('data', () => {});
    proc.on('close', () => { if (session.preloaded?.proc === proc) session.preloaded = null; });

    const firstChunk = await new Promise((resolve) => {
      const timer = setTimeout(() => { proc.kill(); resolve(null); }, 5000);
      proc.stdout.once('data', (d) => { clearTimeout(timer); resolve(d); });
      proc.on('close',  () => { clearTimeout(timer); resolve(null); });
      proc.on('error',  () => { clearTimeout(timer); resolve(null); });
    });

    if (firstChunk?.length > 0) {
      session.preloaded = { video: next, proc };
      logger.info(`[${session.guildId}] Preloaded: ${next.title}`);
    } else {
      proc.kill();
    }
  } catch {
    session.preloaded = null;
  }
}

// ---------------------------------------------------------------------------
// Public: playRandom, playLatest, playVideo, resume
// ---------------------------------------------------------------------------

export async function playLatest(guild, channel) {
  const session = getSession(guild.id);
  await stopPlayback(guild.id, { manual: false });

  const video    = await getLatestVideo();
  session.mode   = 'latest';
  session.continuous = true;
  session.current    = video;
  session.playedIds.add(video.videoId);

  const catalog = await getVideos();
  migrateSessionToQueue(session, catalog);
  syncQueueWithCatalog(session, catalog);

  await connectAndPlay(guild, channel, video);
  return session.current;
}

export async function playVideo(guild, channel, video) {
  const session = getSession(guild.id);
  await stopPlayback(guild.id, { manual: false });

  session.mode   = 'manual';
  session.continuous = true;
  session.current    = video;
  session.playedIds.add(video.videoId);

  const catalog = await getVideos();
  migrateSessionToQueue(session, catalog);
  syncQueueWithCatalog(session, catalog);

  await connectAndPlay(guild, channel, video);
  return session.current;
}

export async function playRandom(guild, channel) {
  const session = getSession(guild.id);
  await stopPlayback(guild.id, { manual: false });

  session.mode   = 'random';
  session.continuous = true;

  const catalog = await getVideos();
  migrateSessionToQueue(session, catalog);
  syncQueueWithCatalog(session, catalog);

  const { videoId, newCycle } = popFromQueue(session, catalog);
  if (newCycle) {
    notify('🟢 دورة جديدة', NOTIFY.newCycle(session.cycleCount - 1, catalog.length), 'info').catch(() => {});
  }
  const video = catalog.find((v) => v.videoId === videoId);
  if (!video) {
    logger.error(`[${guild.id}] Video ${videoId} not found in catalog.`);
    return null;
  }

  session.current = video;
  session.playedIds.add(video.videoId);

  await connectAndPlay(guild, channel, video);
  return session.current;
}

export async function resume(guild, channel) {
  const session     = getSession(guild.id);
  const savedVideo  = session.current || await restoreLastVideo(guild.id);
  const savedElapsed = session.current
    ? Math.floor(getElapsedSeconds(session))
    : (savedVideo?.progressSeconds || 0);

  await stopPlayback(guild.id, { manual: false });

  if (!savedVideo) throw new Error('لا يوجد مقطع سابق للاستكمال.');

  session.mode   = 'resume';
  session.continuous = true;
  session.current    = { ...savedVideo, progressSeconds: savedElapsed };

  await connectAndPlay(guild, channel, session.current);
  return session.current;
}

// ---------------------------------------------------------------------------
// Core: connectAndPlay
// ---------------------------------------------------------------------------

export async function connectAndPlay(guild, channel, video, { countPlay = true } = {}) {
  const session = getSession(guild.id);
  session.guild   = guild;
  session.channel = channel;

  // ── Health check: ensure guild/channel are still valid ──
  if (!guild.available || !channel) {
    logger.warn(`[${guild.id}] Guild or channel unavailable — skipping play.`);
    return;
  }

  logger.info(`[${guild.id}] Playing: ${video.title}`);

  // ── الاتصال بالقناة الصوتية ──
  const alreadyHere = session.connection
    && session.connection.joinConfig.channelId === channel.id
    && session.connection.state.status !== VoiceConnectionStatus.Destroyed;

  if (!alreadyHere) {
    const oldConn = session.connection;
    session.connection = null;
    if (oldConn) { try { oldConn.destroy(); } catch {} }

    session.connection = joinVoiceChannel({
      channelId:       channel.id,
      guildId:         guild.id,
      adapterCreator:  guild.voiceAdapterCreator,
      selfDeaf:        true,
    });

    const thisConnection = session.connection;

    thisConnection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (session.connection !== thisConnection) return;
      try {
        await Promise.race([
          entersState(thisConnection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(thisConnection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (session.connection !== thisConnection) return;
        logger.warn(`[${guild.id}] Voice connection lost.`);
        try { thisConnection.destroy(); } catch {}
        session.connection = null;
        freezeProgress(session);
        stopProgressAutosave(session);
        saveState(session);
        if (session.continuous && !session.manualStop) {
          logger.info(`[${guild.id}] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
          setTimeout(() => rejoinAndResume(guild, channel), RECONNECT_DELAY_MS);
        }
      }
    });

    try {
      await entersState(session.connection, VoiceConnectionStatus.Ready, 60_000);
      logger.info(`[${guild.id}] Connected to #${channel.name}`);
    } catch (err) {
      try { session.connection.destroy(); } catch {}
      session.connection = null;
      throw new Error(`تعذّر الاتصال بالقناة الصوتية: ${err.message}`);
    }
  } else {
    logger.info(`[${guild.id}] Already connected to #${channel.name}, reusing connection.`);
  }

  // ── جينغل (اختياري) ──
  if (countPlay) {
    await playRandomJingle(guild, channel);
  }

  // ── إنشاء بث الصوت ──
  const startSeconds = Math.max(0, Math.floor(video.progressSeconds || 0));
  const { stream, ffmpegProcess } = await createAudioStream(session, video.url, startSeconds, session.volume);
  session.ffmpegProcess = ffmpegProcess;

  // ── Dead stream detection — dynamic timeout based on video duration ──
  const deadStreamTimeout = dynamicTimeout(video.durationSeconds, 0.01, 60_000, 1_800_000);
  const deadCheckIntervalMs = Math.max(30_000, Math.floor(deadStreamTimeout / 6));
  let lastDataTime = Date.now();
  logger.info(`[${guild.id}] Dead stream timeout: ${Math.round(deadStreamTimeout / 1000)}s (video: ${video.durationSeconds || '?'}s)`);
  const deadCheckInterval = setInterval(() => {
    if (session.player !== player) { clearInterval(deadCheckInterval); return; }
    if (!session.connection || session.connection.state.status === VoiceConnectionStatus.Destroyed) {
      clearInterval(deadCheckInterval);
      return;
    }
    const elapsed = Date.now() - lastDataTime;
    if (elapsed > deadStreamTimeout && session.player?.state?.status === AudioPlayerStatus.Playing) {
      logger.warn(`[${guild.id}] No audio data for ${Math.round(elapsed / 1000)}s — dead stream, restarting from current position.`);
      clearInterval(deadCheckInterval);
      const currentElapsed = Math.floor(getElapsedSeconds(session));
      session.current = { ...session.current, progressSeconds: currentElapsed };
      connectAndPlay(guild, channel, session.current, { countPlay: false })
        .catch(() => onTrackFinished(guild, channel));
    }
  }, deadCheckIntervalMs);

  stream.on('data', () => { lastDataTime = Date.now(); });
  stream.on('end', () => { clearInterval(deadCheckInterval); });

  stream.on('error', (err) => {
    clearInterval(deadCheckInterval);
    if (err.code === 'EPIPE') return;
    if (err.message?.includes('Premature close')) {
      logger.warn(`[${guild.id}] Audio stream ended prematurely (network drop?).`);
      return;
    }
    logger.error(`[${guild.id}] Audio stream error: ${err.message}`);
    if (session.player === player) {
      try { session.player.stop(true); } catch {}
    }
  });

  const resource = createAudioResource(stream, {
    inputType:      StreamType.Raw,
    highWaterMark:  1024 * 64,
  });
  session.resource = resource;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  session.player = player;
  session.paused = false;
  session.isLive = false; // سيُكتشف لاحقاً عبر isLiveStream

  // ── Stall Detection — dynamic timeout based on video duration ──
  const stallTimeoutMs = dynamicTimeout(video.durationSeconds, 0.005, 60_000, 900_000);
  logger.info(`[${guild.id}] Stall timeout: ${Math.round(stallTimeoutMs / 1000)}s`);
  if (session.stallTimeout) { clearTimeout(session.stallTimeout); session.stallTimeout = null; }
  player.on('stateChange', (oldState, newState) => {
    if (session.player !== player) return;
    if (newState.status === AudioPlayerStatus.Playing) {
      if (session.stallTimeout) { clearTimeout(session.stallTimeout); session.stallTimeout = null; }
    } else if (
      newState.status === AudioPlayerStatus.AutoPaused ||
      newState.status === AudioPlayerStatus.Buffering
    ) {
      if (!session.stallTimeout) {
        session.stallTimeout = setTimeout(() => {
          if (session.player !== player) return;
          if (!session.connection || session.connection.state.status === VoiceConnectionStatus.Destroyed) return;
          logger.warn(`[${guild.id}] Stream stalled for ${Math.round(stallTimeoutMs / 1000)}s. Restarting from current position.`);
          const elapsed = Math.floor(getElapsedSeconds(session));
          session.current = { ...session.current, progressSeconds: elapsed };
          connectAndPlay(guild, channel, session.current, { countPlay: false })
            .catch(() => onTrackFinished(guild, channel));
        }, stallTimeoutMs);
      }
    } else {
      if (session.stallTimeout) { clearTimeout(session.stallTimeout); session.stallTimeout = null; }
    }
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (session.player !== player) return;
    if (session.interjecting) return;
    if (!session.connection || session.connection.state.status === VoiceConnectionStatus.Destroyed) {
      logger.warn(`[${guild.id}] Track finished but connection destroyed — stopping.`);
      return;
    }
    logger.info(`[${guild.id}] Track finished.`);
    onTrackFinished(guild, channel);
  });

  player.on('error', (err) => {
    if (session.player !== player) return;
    if (session.interjecting) return;
    logger.error(`[${guild.id}] Player error:`, err.message);
    if (!session.connection || session.connection.state.status === VoiceConnectionStatus.Destroyed) return;
    onTrackFinished(guild, channel);
  });

  session.connection.subscribe(player);
  player.play(resource);

  session.segmentStartOffset = startSeconds;
  session.segmentStartedAt   = Date.now();
  session.current            = { ...video, progressSeconds: startSeconds };
  startProgressAutosave(session);
  await saveState(session);

  // ── تحديث UI فوري ──
  triggerUiUpdate(session).catch(() => {});
  playerEvents.emit('trackChange', { guildId: guild.id, video: session.current, paused: false });

  // ── Preload المقطع التالي قرب النهاية ──
  if (video.durationSeconds && video.durationSeconds > 30) {
    const preloadAt = Math.max(5_000, (video.durationSeconds - 15) * 1000);
    setTimeout(() => {
      if (session.current?.videoId === video.videoId && session.continuous) {
        preloadNextTrack(session).catch(() => {});
      }
    }, preloadAt);
  }

  // ── تسجيل التشغيل ──
  if (countPlay && startSeconds === 0) {
    recordPlay(video);
  }

  // ── إثراء بيانات الفيديو في الخلفية ──
  enrichWithDetails(video).then((enriched) => {
    if (session.current?.videoId === enriched.videoId) {
      session.current = {
        ...session.current,
        durationSeconds: enriched.durationSeconds,
        thumbnail:       enriched.thumbnail,
        viewCount:       enriched.viewCount,
        publishedAt:     enriched.publishedAt,
      };
    }
    triggerUiUpdate(session).catch(() => {});
  }).catch(() => {});

  // ── كشف البث المباشر (في الخلفية) ──
  isLiveStream(video.url).then((live) => {
    if (session.current?.videoId === video.videoId) {
      session.isLive = live;
      if (live) {
        session.mode = 'live';
        logger.info(`[${guild.id}] Detected live stream: ${video.title}`);
        playerEvents.emit('trackChange', { guildId: guild.id, video: session.current, paused: false });
      }
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Track transition
// ---------------------------------------------------------------------------

async function onTrackFinished(guild, channel) {
  const session = getSession(guild.id);
  if (session.advancing) return;
  session.advancing = true;
  session.advancingSince = Date.now();

  try {
    // البث المباشر لا يُكمّل تلقائياً (ينتهي فقط بأمر يدوي)
    if (session.isLive) {
      logger.info(`[${guild.id}] Live stream ended — stopping.`);
      await stopPlayback(guild.id, { manual: false });
      return;
    }

    if (!session.continuous) {
      logger.info(`[${guild.id}] Continuous mode off. Stopping.`);
      await stopPlayback(guild.id, { manual: false });
      return;
    }

    // تسجيل نتيجة المقطع الحالي
    if (session.segmentStartedAt) {
      const playedSeconds = (Date.now() - session.segmentStartedAt) / 1000;
      const expectedDuration = session.current?.durationSeconds || 0;

      // Dynamic early end threshold: shorter for short videos, longer for long videos
      // 5min video → 10%, 1hr video → 5%, 10hr video → 2%
      const earlyEndPct = expectedDuration > 3600 ? 0.02 : expectedDuration > 600 ? 0.05 : 0.10;

      if (playedSeconds < 10 && session.current?.videoId) {
        session.retryCount = (session.retryCount || 0) + 1;
        if (session.retryCount <= 3) {
          logger.warn(`[${guild.id}] Track played only ${Math.round(playedSeconds)}s — retrying (${session.retryCount}/3)...`);
          session.current = { ...session.current, progressSeconds: 0 };
          session.advancing = false;
          connectAndPlay(guild, channel, session.current, { countPlay: false }).catch(() => onTrackFinished(guild, channel));
          return;
        } else {
          logger.warn(`[${guild.id}] Track played only ${Math.round(playedSeconds)}s — broken URL, skipping.`);
          addFailedId(session, session.current.videoId);
          recordPlay(session.current, { failed: true }).catch(() => {});
          await sleep(3000);
          session.retryCount = 0; // reset for next track
        }
      } else if (expectedDuration > 120 && playedSeconds < expectedDuration * earlyEndPct && session.current?.videoId) {
        const pct = Math.round(playedSeconds / expectedDuration * 100);
        logger.warn(`[${guild.id}] Track ended early: ${Math.round(playedSeconds)}s/${expectedDuration}s (${pct}%) — stream dropped, retrying from where it stopped.`);
        session.current = { ...session.current, progressSeconds: Math.floor(playedSeconds) };
        recordPlay(session.current, { failed: true }).catch(() => {});
        await sleep(2000);
        
        // Actually retry the current track
        session.advancing = false;
        connectAndPlay(guild, channel, session.current, { countPlay: false }).catch(() => onTrackFinished(guild, channel));
        return;
      } else if (session.current?.videoId) {
        recordPlay(session.current, { completed: true }).catch(() => {});
        session.retryCount = 0;
      }
    } else if (session.current?.videoId) {
      recordPlay(session.current, { completed: true }).catch(() => {});
      session.retryCount = 0;
    }

    let attempt = 0;
    const MAX_ATTEMPTS = 10;
    let nextVideoCandidate = null;

    while (session.continuous && !session.manualStop && attempt < MAX_ATTEMPTS) {
      try {
        await playRandomJingle(guild, channel);

        let next;
        if (nextVideoCandidate) {
          next = nextVideoCandidate;
        } else if (session.preloaded?.video) {
          next = session.preloaded.video;
          if (session.preloaded.proc) { try { session.preloaded.proc.kill('SIGKILL'); } catch {} }
          session.preloaded = null;
        } else {
          const catalog = await getVideos();
          syncQueueWithCatalog(session, catalog);
          const { videoId, newCycle } = popFromQueue(session, catalog);
          if (newCycle) {
            notify('🟢 دورة جديدة', NOTIFY.newCycle(session.cycleCount - 1, catalog.length), 'info').catch(() => {});
          }
          next = catalog.find((v) => v.videoId === videoId);
        }

        if (!next) {
          logger.warn(`[${guild.id}] No next video found, stopping.`);
          break;
        }

        const valid = await preValidateVideo(next.url);
        if (!valid) {
          attempt += 1;
          const delay = jitteredDelay(RETRY_BASE_DELAY_MS, attempt);
          logger.warn(`[${guild.id}] Pre-validation failed for ${next.title} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
          
          if (attempt >= 3) {
            logger.warn(`[${guild.id}] Skipping ${next.title} after 3 pre-validation failures.`);
            addFailedId(session, next.videoId);
            recordPlay(next, { failed: true }).catch(() => {});
            nextVideoCandidate = null; // force pop new video on next iteration
          } else {
            nextVideoCandidate = next; // retain for retry
            await sleep(delay);
          }
          continue; // loop again (attempt is incremented)
        }

        nextVideoCandidate = null;
        session.current = next;
        session.playedIds.add(next.videoId);
        await connectAndPlay(guild, channel, next);
        return;
      } catch (err) {
        attempt += 1;
        const delay = jitteredDelay(RETRY_BASE_DELAY_MS, attempt);
        logger.error(
          `[${guild.id}] Failed to play next (attempt ${attempt}/${MAX_ATTEMPTS}):`,
          err.message,
          attempt < MAX_ATTEMPTS ? `retrying in ${delay / 1000}s…` : 'giving up.',
        );
        if (attempt < MAX_ATTEMPTS) await sleep(delay);
      }
    }

    if (attempt >= MAX_ATTEMPTS) {
      logger.error(`[${guild.id}] Stopped after ${MAX_ATTEMPTS} failed attempts.`);
      notify('🔴 توقف', NOTIFY.stopped(guild.name || guild.id, MAX_ATTEMPTS), 'error').catch(() => {});
      logDashboardError(`Guild ${guild.id} stopped after ${MAX_ATTEMPTS} failed attempts.`);
      await stopPlayback(guild.id, { manual: false });
    }
  } finally {
    session.advancing = false;
  }
}

// ---------------------------------------------------------------------------
// Rejoin after disconnect
// ---------------------------------------------------------------------------

async function rejoinAndResume(guild, channel, attempt = 1) {
  const session = getSession(guild.id);
  if (!session.continuous || session.manualStop) return;

  if (attempt > 20) {
    logger.error(`[${guild.id}] Giving up rejoin after ${attempt} attempts.`);
    logDashboardError(`[${guild.id}] Giving up rejoin after ${attempt} attempts.`);
    await stopPlayback(guild.id, { manual: false });
    return;
  }

  try {
    const freshChannel = await guild.channels.fetch(channel.id).catch(() => channel);
    if (!freshChannel || (freshChannel.isVoiceBased && !freshChannel.isVoiceBased())) {
      await stopPlayback(guild.id, { manual: false });
      return;
    }

    let video = session.current;
    if (!video) {
      const catalog = await getVideos();
      syncQueueWithCatalog(session, catalog);
      const { videoId } = popFromQueue(session, catalog);
      video = catalog.find((v) => v.videoId === videoId);
    }

    await playRandomJingle(guild, freshChannel);
    await connectAndPlay(guild, freshChannel, video, { countPlay: false });
    logger.info(`[${guild.id}] Rejoined and resumed.`);
  } catch (err) {
    const delay = jitteredDelay(RETRY_BASE_DELAY_MS, attempt);
    logger.error(`[${guild.id}] Rejoin failed:`, err.message);
    logDashboardError(`[${guild.id}] Rejoin failed (attempt ${attempt}): ${err.message}`);
    if (attempt === 5) {
      notify('🟡 Voice Rejoin Struggling', NOTIFY.rejoinFailed(guild.id, attempt, err.message), 'warn').catch(() => {});
    }
    setTimeout(() => rejoinAndResume(guild, channel, attempt + 1), delay);
  }
}
