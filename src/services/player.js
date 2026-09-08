/**
 * Audio playback engine.
 *
 * Plays YouTube audio via yt-dlp → ffmpeg → @discordjs/voice.
 * Continuous 24/7 playback with progress saving for /كمل resume.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
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
import { getRandomVideo, getLatestVideo, getVideoDetails } from './youtube.js';
import {
  getSession, sessions, saveState, restoreLastVideo, loadAllState,
  getElapsedSeconds, freezeProgress, startProgressAutosave, stopProgressAutosave,
  trackRecent,
} from './session.js';
import { createAudioStream, killProcesses, preValidateVideo, formatTime } from './streaming.js';
import { listSounds, resolveSoundPath } from '../utils/sounds.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { buildNowPlayingMessage } from '../utils/embeds.js';
import { recordPlay } from '../utils/stats.js';
import { notify } from '../utils/webhook.js';

const logger = createLogger('audio');

export const playerEvents = new EventEmitter();

const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;
const RECONNECT_DELAY_MS = 10_000;
const UI_REFRESH_MS = 15_000;
const PRELOAD_THRESHOLD_MS = 10_000;

// ---------------------------------------------------------------------------
// Jingle rotation — least-recently-played weighting
// ---------------------------------------------------------------------------

const jingleLastPlayed = new Map();

function pickJingle(sounds) {
  if (sounds.length === 0) return null;
  if (sounds.length === 1) return sounds[0];

  const now = Date.now();
  const weights = sounds.map((name) => {
    const last = jingleLastPlayed.get(name) || 0;
    const age = now - last;
    return Math.max(1, age / 60_000);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < sounds.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      jingleLastPlayed.set(sounds[i], now);
      return sounds[i];
    }
  }
  const fallback = sounds[sounds.length - 1];
  jingleLastPlayed.set(fallback, now);
  return fallback;
}

// ---------------------------------------------------------------------------
// Now Playing message
// ---------------------------------------------------------------------------

export function attachNowPlayingMessage(guildId, message) {
  const session = getSession(guildId);
  session.nowPlayingMessage = message;
  startUiRefresh(session);
  updateNowPlayingMessage(session).catch(() => {});
}

function startUiRefresh(session) {
  stopUiRefresh(session);
  session.uiTimer = setInterval(() => {
    updateNowPlayingMessage(session).catch(() => {});
  }, UI_REFRESH_MS);
}

function stopUiRefresh(session) {
  if (session.uiTimer) {
    clearInterval(session.uiTimer);
    session.uiTimer = null;
  }
}

async function updateNowPlayingMessage(session) {
  if (!session.nowPlayingMessage || !session.current) return;
  try {
    const msg = buildNowPlayingMessage(session.current, {
      volume: session.volume,
      mode: session.mode,
      continuous: session.continuous,
      paused: session.paused,
      elapsedSeconds: getElapsedSeconds(session),
    });
    await session.nowPlayingMessage.edit(msg);
  } catch {
    session.nowPlayingMessage = null;
    stopUiRefresh(session);
  }
}

async function enrichWithDetails(video) {
  if (!video?.videoId) return video;
  const details = await getVideoDetails(video.videoId).catch(() => null);
  if (!details) return video;
  return {
    ...video,
    durationSeconds: details.durationSeconds,
    thumbnail: video.thumbnail || details.thumbnail,
    viewCount: details.viewCount,
    publishedAt: details.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function stopPlayback(guildId, { manual = true } = {}) {
  const session = getSession(guildId);
  if (session.manualStop && manual) return;
  session.continuous = false;
  session.manualStop = manual;
  session.queue = [];
  session.paused = false;

  freezeProgress(session);
  stopProgressAutosave(session);

  if (manual) {
    stopUiRefresh(session);
    session.nowPlayingMessage = null;
  }

  const player = session.player;
  session.player = null;
  if (player) {
    try { player.stop(true); } catch {}
  }

  // Only destroy connection on manual stop or when explicitly requested
  if (manual) {
    const conn = session.connection;
    session.connection = null;
    if (conn) {
      try { conn.destroy(); } catch {}
    }
  }

  killProcesses(session);
  saveState(session);
  playerEvents.emit('trackChange', { guildId, video: null, paused: false });
  logger.info(`[${guildId}] Stopped playback${manual ? ' and disconnected.' : '.'}`);
}

export function stopAllSessions() {
  for (const guildId of sessions.keys()) {
    stopPlayback(guildId);
  }
}

export function getAllSessions() {
  const result = [];
  for (const [guildId, session] of sessions) {
    if (!session.connection && !session.current) continue;
    result.push({
      guildId,
      guildName: session.guild?.name || guildId,
      title: session.current?.title || null,
      videoId: session.current?.videoId || null,
      url: session.current?.url || null,
      thumbnail: session.current?.thumbnail || null,
      mode: session.mode,
      volume: session.volume,
      paused: session.paused,
      connected: Boolean(session.connection),
      continuous: session.continuous,
      queueCount: session.queue.length,
      elapsedSeconds: session.current ? getElapsedSeconds(session) : 0,
      durationSeconds: session.current?.durationSeconds || null,
    });
  }
  return result;
}

export function skipTrack(guildId) {
  const session = getSession(guildId);
  if (!session.player) return;
  // Kill the media processes to force audio to stop
  killProcesses(session);
  // Stop the player — this fires Idle event which will call onTrackFinished
  // We do NOT null session.player here so the Idle handler recognizes it
  try { session.player.stop(true); } catch {}
  logger.info(`[${guildId}] Track skipped.`);
}

export async function setVolume(guildId, volume) {
  const session = getSession(guildId);
  const clamped = Math.max(0, Math.min(200, volume));
  session.volume = clamped;
  saveState(session);

  // If currently playing, restart stream with new volume
  if (session.current && session.connection && session.guild && session.channel && !session.volumeChanging) {
    session.volumeChanging = true;
    try {
      const elapsed = Math.floor(getElapsedSeconds(session));
      const video = { ...session.current, progressSeconds: elapsed };
      await connectAndPlay(session.guild, session.channel, video, { countPlay: false });
    } catch (err) {
      logger.warn(`[${guildId}] Volume change restart failed:`, err.message);
    } finally {
      session.volumeChanging = false;
    }
  }

  return clamped;
}

export function getSessionInfo(guildId) {
  const session = getSession(guildId);
  return {
    current: session.current,
    mode: session.mode,
    continuous: session.continuous,
    volume: session.volume,
    paused: session.paused,
    connected: Boolean(session.connection),
    elapsedSeconds: session.current ? getElapsedSeconds(session) : 0,
    queueCount: session.queue.length,
    videoId: session.current?.videoId || null,
    videoUrl: session.current?.url || null,
    thumbnail: session.current?.thumbnail || null,
    durationSeconds: session.current?.durationSeconds || null,
  };
}

export async function playLatest(guild, channel) {
  const session = getSession(guild.id);
  stopPlayback(guild.id, { manual: false });

  const video = await getLatestVideo();
  session.mode = 'latest';
  session.continuous = true;
  session.current = video;
  trackRecent(session, video.videoId);

  await connectAndPlay(guild, channel, video);
  return session.current;
}

export async function playRandom(guild, channel) {
  const session = getSession(guild.id);
  stopPlayback(guild.id, { manual: false });

  session.mode = 'random';
  session.continuous = true;

  const video = await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
  session.current = video;
  trackRecent(session, video.videoId);

  await connectAndPlay(guild, channel, video);
  return session.current;
}

export async function resume(guild, channel) {
  const session = getSession(guild.id);
  const last = session.current || restoreLastVideo(guild.id);
  stopPlayback(guild.id, { manual: false });

  if (!last) {
    throw new Error('لا يوجد مقطع سابق للاستكمال.');
  }

  session.mode = 'resume';
  session.continuous = true;
  session.current = last;

  await connectAndPlay(guild, channel, last);
  return session.current;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Track preloading — resolve next video stream in background
// ---------------------------------------------------------------------------

async function preloadNextTrack(session) {
  if (session.preloaded) return;
  try {
    const next = session.queue[0]
      || await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
    if (!next?.url) return;
    const ytDlpArgs = [
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '-o', '-',
      '--no-part',
      '--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`,
    ];
    const browserCookieSource = process.env.COOKIE_BROWSER || 'edge';
    const cookiesPath = join(process.cwd(), 'cookies.txt');
    if (browserCookieSource !== 'none') {
      ytDlpArgs.push('--cookies-from-browser', browserCookieSource);
    } else if (existsSync(cookiesPath)) {
      ytDlpArgs.push('--cookies', cookiesPath);
    }
    ytDlpArgs.push(next.url);
    const proc = spawn('yt-dlp', ytDlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', () => {});
    const firstChunk = await new Promise((resolve) => {
      const timer = setTimeout(() => { proc.kill(); resolve(null); }, 5000);
      proc.stdout.once('data', (data) => { clearTimeout(timer); resolve(data); });
      proc.on('close', () => { clearTimeout(timer); resolve(null); });
      proc.on('error', () => { clearTimeout(timer); resolve(null); });
    });
    if (firstChunk && firstChunk.length > 0) {
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
// Sound effect — plays a local file and resolves (no resume logic)
// ---------------------------------------------------------------------------

export function playSoundEffect(guild, channel, filePath) {
  const session = getSession(guild.id);

  return new Promise((resolve, reject) => {
    const alreadyHere = session.connection
      && session.connection.joinConfig.channelId === channel.id
      && session.connection.state.status !== VoiceConnectionStatus.Destroyed;

    if (!alreadyHere) {
      if (session.connection) {
        try { session.connection.destroy(); } catch {}
      }
      session.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      entersState(session.connection, VoiceConnectionStatus.Ready, 30_000)
        .then(() => playFile())
        .catch((err) => reject(new Error(`تعذّر الاتصال بالقناة الصوتية: ${err.message}`)));
    } else {
      playFile();
    }

    function playFile() {
      const effectPlayer = createAudioPlayer();
      let resource;
      try {
        resource = createAudioResource(filePath);
      } catch (err) {
        reject(new Error(`تعذّر تشغيل الملف الصوتي: ${err.message}`));
        return;
      }

      effectPlayer.on('error', (err) => {
        logger.error(`[${guild.id}] Sound effect error:`, err.message);
        reject(err);
      });

      effectPlayer.on(AudioPlayerStatus.Idle, () => {
        resolve();
      });

      session.connection.subscribe(effectPlayer);
      effectPlayer.play(resource);
    }
  });
}

// ---------------------------------------------------------------------------
// Jingle — plays a random sound between tracks
// ---------------------------------------------------------------------------

async function playRandomSound(guild, channel) {
  const session = getSession(guild.id);
  try {
    const sounds = listSounds();
    if (sounds.length === 0) return;

    const name = pickJingle(sounds);
    const filePath = resolveSoundPath(name);
    if (!filePath) return;

    const alreadyHere = session.connection
      && session.connection.joinConfig.channelId === channel.id
      && session.connection.state.status !== VoiceConnectionStatus.Destroyed;
    if (!alreadyHere) return;

    const mainPlayer = session.player;
    if (!mainPlayer) return;

    logger.info(`[${guild.id}] Jingle: ${name}`);

    await new Promise((resolve) => {
      const jinglePlayer = createAudioPlayer();
      let resource;
      try {
        resource = createAudioResource(filePath);
      } catch {
        resolve();
        return;
      }

      const cleanup = () => {
        try { session.connection?.subscribe(mainPlayer); } catch {}
        resolve();
      };

      jinglePlayer.on('error', cleanup);
      jinglePlayer.on(AudioPlayerStatus.Idle, cleanup);

      session.connection.subscribe(jinglePlayer);
      jinglePlayer.play(resource);
    });
  } catch (err) {
    logger.warn(`[${guild.id}] Jingle failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Core: connect and play a video
// ---------------------------------------------------------------------------

async function connectAndPlay(guild, channel, video, { countPlay = true } = {}) {
  const session = getSession(guild.id);
  session.guild = guild;
  session.channel = channel;

  logger.info(`[${guild.id}] Playing: ${video.title}`);

  const alreadyHere = session.connection
    && session.connection.joinConfig.channelId === channel.id
    && session.connection.state.status !== VoiceConnectionStatus.Destroyed;

  if (!alreadyHere) {
    const oldConn = session.connection;
    session.connection = null;
    if (oldConn) {
      try { oldConn.destroy(); } catch {}
    }

    session.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
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

  const startSeconds = Math.max(0, Math.floor(video.progressSeconds || 0));
  const { stream, ffmpegProcess } = await createAudioStream(session, video.url, startSeconds, session.volume);
  session.ffmpegProcess = ffmpegProcess;

  const resource = createAudioResource(stream, {
    inputType: StreamType.Raw,
  });
  session.resource = resource;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  session.player = player;
  session.paused = false;

  if (session.stallTimeout) { clearTimeout(session.stallTimeout); session.stallTimeout = null; }
  session.stallTimeout = null;
  player.on('stateChange', (oldState, newState) => {
    if (session.player !== player) return;
    if (newState.status === AudioPlayerStatus.Playing) {
      if (session.stallTimeout) { clearTimeout(session.stallTimeout); session.stallTimeout = null; }
    } else if (newState.status === AudioPlayerStatus.AutoPaused || newState.status === AudioPlayerStatus.Buffering) {
      if (!session.stallTimeout) {
        session.stallTimeout = setTimeout(() => {
          logger.warn(`[${guild.id}] Stream stalled for 30s. Skipping track.`);
          if (session.player === player) {
            onTrackFinished(guild, channel);
          }
        }, 30_000);
      }
    } else {
      if (session.stallTimeout) { clearTimeout(session.stallTimeout); session.stallTimeout = null; }
    }
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (session.player !== player) return;
    if (session.interjecting) return;
    logger.info(`[${guild.id}] Track finished.`);
    onTrackFinished(guild, channel);
  });

  player.on('error', (err) => {
    if (session.player !== player) return;
    if (session.interjecting) return;
    logger.error(`[${guild.id}] Player error:`, err.message);
    onTrackFinished(guild, channel);
  });

  session.connection.subscribe(player);
  player.play(resource);

  session.segmentStartOffset = startSeconds;
  session.segmentStartedAt = Date.now();
  session.current = { ...video, progressSeconds: startSeconds };
  startProgressAutosave(session);
  saveState(session);
  updateNowPlayingMessage(session).catch(() => {});
  playerEvents.emit('trackChange', { guildId: guild.id, video: session.current, paused: false });

  // Preload next track when current is near the end
  if (video.durationSeconds && video.durationSeconds > 30) {
    const preloadAt = Math.max(5_000, (video.durationSeconds - 15) * 1000);
    setTimeout(() => {
      if (session.current?.videoId === video.videoId && session.continuous) {
        preloadNextTrack(session).catch(() => {});
      }
    }, preloadAt);
  }

  if (countPlay && startSeconds === 0) {
    recordPlay(video);
  }

  enrichWithDetails(video).then((enriched) => {
    if (session.current && session.current.videoId === enriched.videoId) {
      session.current = {
        ...session.current,
        durationSeconds: enriched.durationSeconds,
        thumbnail: enriched.thumbnail,
        viewCount: enriched.viewCount,
        publishedAt: enriched.publishedAt,
      };
    }
    updateNowPlayingMessage(session).catch(() => {});
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Retry logic — jittered backoff for track transitions and rejoin
// ---------------------------------------------------------------------------

function jitteredDelay(baseMs, attempt) {
  const delay = Math.min(baseMs * attempt, RETRY_MAX_DELAY_MS);
  const jitter = delay * (0.8 + Math.random() * 0.4);
  return Math.floor(jitter);
}

// ---------------------------------------------------------------------------
// Track transition — when a video ends, play jingle then next video
// ---------------------------------------------------------------------------

async function onTrackFinished(guild, channel) {
  const session = getSession(guild.id);
  if (session.advancing) return;
  session.advancing = true;

  try {
    if (!session.continuous) {
      logger.info(`[${guild.id}] Continuous mode off. Stopping.`);
      stopPlayback(guild.id, { manual: false });
      return;
    }

    if (session.segmentStartedAt) {
      const playedSeconds = (Date.now() - session.segmentStartedAt) / 1000;
      if (playedSeconds < 10 && session.current?.videoId) {
        logger.warn(`[${guild.id}] Track played only ${Math.round(playedSeconds)}s — broken URL, skipping.`);
        trackRecent(session, session.current.videoId);
        await sleep(3000);
      }
    }

    let attempt = 0;
    const MAX_ATTEMPTS = 10;
    while (session.continuous && !session.manualStop && attempt < MAX_ATTEMPTS) {
      try {
        await playRandomSound(guild, channel);

        let next;
        if (session.preloaded?.video) {
          next = session.preloaded.video;
          session.preloaded = null;
        } else {
          next = session.queue.shift()
            || await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
        }
        const valid = await preValidateVideo(next.url);
        if (!valid) {
          logger.warn(`[${guild.id}] Pre-validation failed for ${next.title}, skipping.`);
          trackRecent(session, next.videoId);
          continue;
        }
        session.current = next;
        trackRecent(session, next.videoId);
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
      logger.error(`[${guild.id}] Stopped after ${MAX_ATTEMPTS} failed attempts to play next track.`);
      notify(
        '🔴 Playback Stopped',
        `Guild \`${guild.id}\` failed to play a track after ${MAX_ATTEMPTS} attempts. Bot is still running but idle.`,
        'error',
      ).catch(() => {});
      stopPlayback(guild.id, { manual: false });
    }
  } finally {
    session.advancing = false;
  }
}

async function rejoinAndResume(guild, channel, attempt = 1) {
  const session = getSession(guild.id);
  if (!session.continuous || session.manualStop) return;

  try {
    const freshChannel = await guild.channels.fetch(channel.id).catch(() => channel);
    if (!freshChannel || (freshChannel.isVoiceBased && !freshChannel.isVoiceBased())) {
      stopPlayback(guild.id, { manual: false });
      return;
    }

    const video = session.current
      || await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
    await connectAndPlay(guild, freshChannel, video, { countPlay: false });
    logger.info(`[${guild.id}] Rejoined and resumed.`);
  } catch (err) {
    const delay = jitteredDelay(RETRY_BASE_DELAY_MS, attempt);
    logger.error(`[${guild.id}] Rejoin failed:`, err.message);
    if (attempt === 5) {
      notify(
        '🟡 Voice Rejoin Struggling',
        `Guild \`${guild.id}\` failed to rejoin ${attempt} times.\n\`${err.message.slice(0, 300)}\``,
        'warn',
      ).catch(() => {});
    }
    setTimeout(() => rejoinAndResume(guild, channel, attempt + 1), delay);
  }
}
