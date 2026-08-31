/**
 * Audio playback engine.
 *
 * Plays YouTube audio via yt-dlp → ffmpeg → @discordjs/voice.
 * Continuous 24/7 playback with progress saving for /كمل resume.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
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
import { listSounds, resolveSoundPath } from '../utils/sounds.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { buildNowPlayingEmbed } from '../utils/embeds.js';
import { recordPlay } from '../utils/stats.js';
import { notify } from '../utils/webhook.js';

const logger = createLogger('audio');

export const playerEvents = new EventEmitter();

const STATE_FILE = join(process.cwd(), 'playback-state.json');
const RECENT_HISTORY_SIZE = 20;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;
const RECONNECT_DELAY_MS = 10_000;
const PROGRESS_AUTOSAVE_MS = 15_000;
const UI_REFRESH_MS = 15_000;

// ---------------------------------------------------------------------------
// Per-guild session
// ---------------------------------------------------------------------------

class GuildSession {
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
  }
}

const sessions = new Map();

function getSession(guildId) {
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

function loadAllState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    logger.error('Failed to load state file:', err.message);
    return {};
  }
}

function saveState(session) {
  try {
    const all = loadAllState();
    all[session.guildId] = {
      current: session.current,
      mode: session.mode,
      continuous: session.continuous,
      volume: session.volume,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    logger.error('Failed to save state:', err.message);
  }
}

function restoreLastVideo(guildId) {
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

function getElapsedSeconds(session) {
  if (session.segmentStartedAt == null) {
    return session.current?.progressSeconds || 0;
  }
  const elapsedSinceSegmentStart = (Date.now() - session.segmentStartedAt) / 1000;
  return session.segmentStartOffset + elapsedSinceSegmentStart;
}

function freezeProgress(session) {
  if (!session.current) return;
  const elapsed = Math.max(0, Math.floor(getElapsedSeconds(session)));
  session.current = { ...session.current, progressSeconds: elapsed };
  session.segmentStartedAt = null;
}

function startProgressAutosave(session) {
  stopProgressAutosave(session);
  session.progressTimer = setInterval(() => {
    if (!session.current || session.segmentStartedAt == null) return;
    const elapsed = Math.max(0, Math.floor(getElapsedSeconds(session)));
    saveState({ ...session, current: { ...session.current, progressSeconds: elapsed } });
  }, PROGRESS_AUTOSAVE_MS);
}

function stopProgressAutosave(session) {
  if (session.progressTimer) {
    clearInterval(session.progressTimer);
    session.progressTimer = null;
  }
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
    const embed = buildNowPlayingEmbed(session.current, {
      volume: session.volume,
      mode: session.mode,
      continuous: session.continuous,
      paused: session.paused,
      elapsedSeconds: getElapsedSeconds(session),
    });
    await session.nowPlayingMessage.edit({ embeds: [embed] });
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
  const conn = session.connection;
  session.connection = null;
  if (conn) {
    try { conn.destroy(); } catch {}
  }
  killProcesses(session);
  saveState(session);
  playerEvents.emit('trackChange', { guildId, video: null, paused: false });
  logger.info(`[${guildId}] Stopped playback and disconnected.`);
}

export function stopAllSessions() {
  for (const guildId of sessions.keys()) {
    stopPlayback(guildId);
  }
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

function trackRecent(session, videoId) {
  if (!videoId) return;
  session.recentIds.push(videoId);
  if (session.recentIds.length > RECENT_HISTORY_SIZE) session.recentIds.shift();
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

    const name = sounds[Math.floor(Math.random() * sounds.length)];
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

        const next = session.queue.shift()
          || await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
        session.current = next;
        trackRecent(session, next.videoId);
        await connectAndPlay(guild, channel, next);
        return;
      } catch (err) {
        attempt += 1;
        const delay = Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_MAX_DELAY_MS);
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
    const delay = Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_MAX_DELAY_MS);
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

// ---------------------------------------------------------------------------
// Process cleanup
// ---------------------------------------------------------------------------

function killProcesses(session) {
  if (session.ffmpegProcess) {
    try { session.ffmpegProcess.kill(); } catch {}
    session.ffmpegProcess = null;
  }
  if (session.resolveProcess) {
    try { session.resolveProcess.kill(); } catch {}
    session.resolveProcess = null;
  }
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Audio streaming — yt-dlp → ffmpeg → PCM
// ---------------------------------------------------------------------------

function createAudioStream(session, youtubeUrl, startSeconds = 0, volume = 100) {
  return new Promise((resolve, reject) => {
    const STREAM_TIMEOUT_MS = 30_000; // kill everything if no data in 30s
    let resolved = false;
    let streamTimeout = null;

    function cleanup() {
      if (streamTimeout) { clearTimeout(streamTimeout); streamTimeout = null; }
    }

    function safeReject(err) {
      if (resolved) return;
      resolved = true;
      cleanup();
      killProcesses(session);
      reject(err);
    }

    function safeResolve(val) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(val);
    }

    // Timeout: if no audio data flows within STREAM_TIMEOUT_MS, abort
    streamTimeout = setTimeout(() => {
      safeReject(new Error('Stream timeout — no audio data received'));
    }, STREAM_TIMEOUT_MS);

    const ytDlpArgs = [
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '-o', '-',
      '--no-part',
    ];

    // Use cookies file if present (required for datacenter IPs)
    const cookiesPath = join(process.cwd(), 'cookies.txt');
    if (existsSync(cookiesPath)) {
      ytDlpArgs.push('--cookies', cookiesPath);
    }

    ytDlpArgs.push(youtubeUrl);

    const ffmpegArgs = [];
    if (startSeconds > 0) {
      ffmpegArgs.push('-ss', String(startSeconds));
    }
    ffmpegArgs.push(
      '-i', 'pipe:0',
      '-af', `volume=${volume / 100}`,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    );

    const ytDlpProcess = spawn('yt-dlp', ytDlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.resolveProcess = ytDlpProcess;

    ytDlpProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.ffmpegProcess = ffmpegProcess;

    ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

    // When yt-dlp closes: if error, kill ffmpeg immediately
    ytDlpProcess.on('close', (code) => {
      session.resolveProcess = null;
      if (code !== 0 && code !== null) {
        try { ffmpegProcess.kill(); } catch {}
        safeReject(new Error(`yt-dlp exited with code ${code}`));
        return;
      }
      // Normal exit — close ffmpeg stdin so it can drain and finish
      try { ffmpegProcess.stdin.end(); } catch {}
    });

    ffmpegProcess.stderr.on('data', () => {});

    ffmpegProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    // First audio data from ffmpeg clears the timeout — stream is alive
    let dataReceived = false;
    ffmpegProcess.stdout.once('data', () => {
      dataReceived = true;
      cleanup(); // streaming started, no more timeout needed
    });

    ffmpegProcess.on('close', (code) => {
      session.ffmpegProcess = null;
      if (!dataReceived && !resolved) {
        safeReject(new Error(`ffmpeg exited with code ${code} before producing audio`));
      }
    });

    logger.info(
      startSeconds > 0
        ? `Resuming from ${formatTime(startSeconds)}…`
        : 'Streaming audio…',
    );
    safeResolve({ stream: ffmpegProcess.stdout, ffmpegProcess });
  });
}
