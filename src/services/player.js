/**
 * Audio playback engine.
 *
 * - Plays YouTube audio via yt-dlp (resolves a direct URL) → @discordjs/voice
 * - Tracks one session per guild
 * - In continuous ("random") mode, pre-fetches an upcoming queue and
 *   avoids repeating recently-played videos
 * - Tracks playback progress (elapsed seconds) for the current track and
 *   autosaves it, so if the bot stops, crashes, or gets disconnected
 *   mid-track, /كمل resumes from that exact position instead of the start
 * - Owns the "Now Playing" message: keeps it updated with a live progress
 *   bar and button controls as tracks change
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

/**
 * Emits 'trackChange' whenever a guild's now-playing state changes
 * (new track, stopped, paused/resumed). index.js listens to this to keep
 * the bot's Discord presence ("Watching <title>") in sync, without the
 * playback engine needing to know anything about the Client itself.
 */
export const playerEvents = new EventEmitter();

const STATE_FILE = join(process.cwd(), 'playback-state.json');
const RECENT_HISTORY_SIZE = 20;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;
const RECONNECT_DELAY_MS = 10_000;
const PROGRESS_AUTOSAVE_MS = 15_000;
const UI_REFRESH_MS = 15_000;
const VOLUME_STEP = 10;

// ---------------------------------------------------------------------------
// Per-guild session
// ---------------------------------------------------------------------------

class GuildSession {
  constructor(guildId) {
    this.guildId = guildId;
    this.connection = null;
    this.player = null;
    this.resource = null;
    this.ytdlpProcess = null;

    /** @type {'random' | 'latest' | 'url' | 'resume' | null} */
    this.mode = null;
    this.continuous = false;
    this.volume = config.defaultVolume;
    this.paused = false;

    /** @type {Array<{title: string, url: string, videoId: string}>} */
    this.queue = [];
    /** @type {string[]} recently played video IDs, to avoid near-term repeats */
    this.recentIds = [];
    /** @type {{title: string, url: string, progressSeconds?: number, durationSeconds?: number|null, thumbnail?: string|null} | null} */
    this.current = null;

    /** True when /stop was called explicitly — suppresses auto-reconnect/retry. */
    this.manualStop = false;
    /** Guards against overlapping "play next track" transitions. */
    this.advancing = false;

    // --- progress tracking, for resuming mid-track ---
    /** Seconds into the track where the *current* ffmpeg segment started. */
    this.segmentStartOffset = 0;
    /** Date.now() when the current segment started playing, or null if not playing/paused. */
    this.segmentStartedAt = null;
    /** Interval handle that periodically persists progress to disk. */
    this.progressTimer = null;
    /** Interval handle that periodically refreshes the Now Playing message. */
    this.uiTimer = null;
    /** Process used to resolve a direct audio URL via `yt-dlp -g`. */
    this.resolveProcess = null;

    /** The Discord message currently showing "Now Playing", kept in sync as tracks change. */
    this.nowPlayingMessage = null;

    /** True while a short local sound effect is interrupting the main stream. */
    this.interjecting = false;

    // --- ambient soundboard (auto-triggered, no command needed) ---
    /** The Guild/voice-Channel objects currently in use — cached so the
     *  ambient sound scheduler can reuse them without needing a command
     *  interaction to hand them over each time. */
    this.guild = null;
    this.channel = null;
  }
}

/** @type {Map<string, GuildSession>} */
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
// State persistence (single JSON file, keyed by guild ID)
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
// Progress tracking (for resuming mid-track and the progress bar)
// ---------------------------------------------------------------------------

/** Elapsed seconds into the currently-playing track, computed live. */
function getElapsedSeconds(session) {
  if (session.segmentStartedAt == null) {
    return session.current?.progressSeconds || 0;
  }
  const elapsedSinceSegmentStart = (Date.now() - session.segmentStartedAt) / 1000;
  return session.segmentStartOffset + elapsedSinceSegmentStart;
}

/** Stop the live progress clock and bake the elapsed time into `session.current`. */
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
    // Persist a live snapshot without freezing the in-memory clock —
    // playback keeps running, only the on-disk copy is updated.
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
// "Now Playing" message (live embed + buttons)
// ---------------------------------------------------------------------------

/** Register the message a command replied with as the live Now Playing card. */
export function attachNowPlayingMessage(guildId, message) {
  const session = getSession(guildId);
  session.nowPlayingMessage = message;
  startUiRefresh(session);
  updateNowPlayingMessage(session).catch(() => {});
}

function startUiRefresh(session) {
  stopUiRefresh(session);
  session.uiTimer = setInterval(() => {
    updateNowPlayingMessage(session).catch((err) => logger.warn('UI refresh failed:', err.message));
  }, UI_REFRESH_MS);
}

function stopUiRefresh(session) {
  if (session.uiTimer) {
    clearInterval(session.uiTimer);
    session.uiTimer = null;
  }
}

async function updateNowPlayingMessage(session, { disabled = false } = {}) {
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
  } catch (err) {
    // The message may have been deleted, or we lost permission — stop trying.
    logger.warn(`[${session.guildId}] Could not update Now Playing message:`, err.message);
    session.nowPlayingMessage = null;
    stopUiRefresh(session);
  }
}

/** Enrich a video with duration/thumbnail/views/upload date (best-effort; embed just omits what's missing). */
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

/**
 * Stop playback and disconnect from voice for one guild.
 * `manual: true` (the default, used by /stop) marks this as a deliberate
 * stop so the reconnect/retry logic below won't try to bring it back.
 * Internal calls (e.g. at the start of /watch) pass `manual: false`.
 */
export function stopPlayback(guildId, { manual = true } = {}) {
  const session = getSession(guildId);
  if (session.manualStop && manual) return; // already stopped manually
  session.continuous = false;
  session.manualStop = manual;
  session.queue = [];
  session.paused = false;

  freezeProgress(session);
  stopProgressAutosave(session);

  if (manual) {
    updateNowPlayingMessage(session, { disabled: true }).catch(() => {});
    stopUiRefresh(session);
    session.nowPlayingMessage = null;
  }

  // Null out the player reference BEFORE stopping it, so the Idle handler's
  // guard (`session.player !== player`) fires and prevents onTrackFinished
  // from being called recursively.
  const player = session.player;
  session.player = null;
  if (player) {
    try { player.stop(true); } catch { /* already stopped */ }
  }
  const conn = session.connection;
  session.connection = null;
  if (conn) {
    try { conn.destroy(); } catch { /* already gone */ }
  }
  killProcesses(session);
  saveState(session);
  playerEvents.emit('trackChange', { guildId, video: null, paused: false });
  logger.info(`[${guildId}] Stopped playback and disconnected.`);
}

/** Stop every active guild session (used on process shutdown). */
export function stopAllSessions() {
  for (const guildId of sessions.keys()) {
    stopPlayback(guildId);
  }
}

/** Snapshot of a guild's current playback state, for the /queue and /status commands. */
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
    queue: session.queue.slice(0, config.queuePreviewSize),
  };
}

/**
 * Join a voice channel and play the channel's latest video, then keep
 * going 24/7 with random picks once it finishes — every play command
 * runs forever unless the ⏹️ button is used.
 */
export async function playLatest(guild, channel) {
  const session = getSession(guild.id);
  stopPlayback(guild.id, { manual: false });

  const video = await getLatestVideo();
  session.mode = 'latest';
  session.continuous = true;
  session.current = video;
  trackRecent(session, video.videoId);

  await connectAndPlay(guild, channel, video);
  prefetchQueue(session).catch((err) => logger.error('Prefetch failed:', err.message));

  return session.current;
}

/** Join a voice channel and play random videos continuously (24/7). */
export async function playRandom(guild, channel) {
  const session = getSession(guild.id);
  stopPlayback(guild.id, { manual: false });

  session.mode = 'random';
  session.continuous = true;

  const video = await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
  session.current = video;
  trackRecent(session, video.videoId);

  await connectAndPlay(guild, channel, video);
  prefetchQueue(session).catch((err) => logger.error('Prefetch failed:', err.message));

  return session.current;
}

/** Resume the last video that was played in this guild — then keeps going 24/7. */
export async function resume(guild, channel) {
  const session = getSession(guild.id);
  const last = session.current || restoreLastVideo(guild.id);
  stopPlayback(guild.id, { manual: false });

  if (!last) {
    throw new Error('لا يوجد مقطع سابق للاستكمال. جرب /watch أولاً.');
  }

  session.mode = 'resume';
  session.continuous = true; // keep playing after this track finishes
  session.current = last;

  await connectAndPlay(guild, channel, last);
  scheduleAmbientSound(session);
  prefetchQueue(session).catch((err) => logger.error('Prefetch failed:', err.message));

  return session.current;
}

/** Skip the currently playing track. In continuous mode, the next one auto-plays. */
export function skip(guildId) {
  const session = getSession(guildId);
  if (!session.player) {
    throw new Error('لا يوجد شيء قيد التشغيل حالياً.');
  }
  logger.info(`[${guildId}] Skipping current track.`);
  session.paused = false;
  session.player.stop(true); // triggers the Idle handler, which advances the queue
}

/** Toggle pause/resume for the current track. Returns the new paused state. */
export function togglePause(guildId) {
  const session = getSession(guildId);
  if (!session.player) {
    throw new Error('لا يوجد شيء قيد التشغيل حالياً.');
  }

  if (session.paused) {
    session.player.unpause();
    session.paused = false;
    session.segmentStartOffset = getElapsedSeconds(session);
    session.segmentStartedAt = Date.now();
  } else {
    session.player.pause(true);
    session.paused = true;
    freezeProgress(session);
  }

  saveState(session);
  updateNowPlayingMessage(session).catch(() => {});
  playerEvents.emit('trackChange', { guildId, video: session.current, paused: session.paused });
  return session.paused;
}

/** Set playback volume (0-200%) for a guild's active session. */
export function setVolume(guildId, percent) {
  const session = getSession(guildId);
  const clamped = Math.max(0, Math.min(200, percent));
  session.volume = clamped;
  saveState(session);
  updateNowPlayingMessage(session).catch(() => {});

  // Restart current track with new volume if something is playing
  if (session.current && session.channel && session.guild) {
    const currentVideo = session.current;
    const startSeconds = Math.max(0, Math.floor(currentVideo.progressSeconds || 0));
    // Kill old ffmpeg first
    if (session.ffmpegProcess) {
      try { session.ffmpegProcess.kill(); } catch { /* already dead */ }
      session.ffmpegProcess = null;
    }
    if (session.player) {
      session.player.stop(true);
    }
    connectAndPlay(session.guild, session.channel, currentVideo, { countPlay: false }).catch((err) => {
      logger.error(`[${guildId}] Failed to restart with new volume:`, err.message);
    });
  }

  return clamped;
}

/** Nudge volume up/down by a fixed step (used by the button controls). */
export function nudgeVolume(guildId, direction) {
  const session = getSession(guildId);
  return setVolume(guildId, session.volume + direction * VOLUME_STEP);
}

/**
 * Play a short local sound effect, interrupting whatever's currently
 * playing without losing its place. If the main stream was playing, it's
 * frozen (not stopped) and automatically resumed from the exact same
 * position once the sound effect finishes. If nothing was playing, the
 * bot joins just for the sound and leaves again afterward (unless this is
 * the configured default voice channel).
 */
/**
 * Play a short local sound effect. If the main stream is active, it's
 * paused, the sound plays, then the main stream resumes seamlessly.
 * Never disconnects from the voice channel.
 */
export function playSoundEffect(guild, channel, filePath) {
  const session = getSession(guild.id);
  const hadMainTrack = Boolean(session.current) && Boolean(session.player) && !session.paused;

  session.interjecting = true;

  return (async () => {
    const alreadyHere = session.connection
      && session.connection.joinConfig.channelId === channel.id
      && session.connection.state.status !== VoiceConnectionStatus.Destroyed;

    if (!alreadyHere) {
      if (session.connection) {
        try { session.connection.destroy(); } catch { /* already gone */ }
      }
      session.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      try {
        await entersState(session.connection, VoiceConnectionStatus.Ready, 30_000);
      } catch (err) {
        session.interjecting = false;
        throw new Error(`تعذّر الاتصال بالقناة الصوتية: ${err.message}`);
      }
    } else if (hadMainTrack) {
      freezeProgress(session);
      stopProgressAutosave(session);
      if (session.player) session.player.stop(true);
    }

    return new Promise((resolve, reject) => {
      const effectPlayer = createAudioPlayer();
      let resource;
      try {
        resource = createAudioResource(filePath);
      } catch (err) {
        session.interjecting = false;
        reject(new Error(`تعذّر تشغيل الملف الصوتي: ${err.message}`));
        return;
      }

      effectPlayer.on('error', (err) => {
        session.interjecting = false;
        logger.error(`[${guild.id}] Sound effect error:`, err.message);
        reject(err);
      });

      effectPlayer.on(AudioPlayerStatus.Idle, async () => {
        session.interjecting = false;
        try {
          if (hadMainTrack && session.current) {
            await connectAndPlay(guild, channel, session.current, { countPlay: false });
          }
        } catch (err) {
          logger.error(`[${guild.id}] Failed to resume after sound effect:`, err.message);
        }
        resolve();
      });

      session.player = effectPlayer;
      session.connection.subscribe(effectPlayer);
      effectPlayer.play(resource);
    });
  })();
}

/**
 * Play a random sound from the sounds folder. Used as a jingle at the
 * start and end of each video. Never disconnects — just plays and resolves.
 */
async function playRandomSound(guild, channel) {
  try {
    const sounds = listSounds();
    if (sounds.length === 0) return;
    const name = sounds[Math.floor(Math.random() * sounds.length)];
    const filePath = resolveSoundPath(name);
    if (!filePath) return;
    logger.info(`[${guild.id}] Jingle: ${name}`);
    await playSoundEffect(guild, channel, filePath);
  } catch (err) {
    logger.warn(`[${guild.id}] Random sound failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function trackRecent(session, videoId) {
  if (!videoId) return;
  session.recentIds.push(videoId);
  if (session.recentIds.length > RECENT_HISTORY_SIZE) session.recentIds.shift();
}

async function prefetchQueue(session) {
  if (!session.continuous) return;
  try {
    const upcoming = [];
    for (let i = 0; i < config.queuePreviewSize; i += 1) {
      const video = await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
      upcoming.push(video);
      trackRecent(session, video.videoId);
    }
    session.queue = upcoming;
  } catch (err) {
    logger.error('Failed to prefetch queue:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectAndPlay(guild, channel, video, { countPlay = true } = {}) {
  const session = getSession(guild.id);
  session.guild = guild;
  session.channel = channel;

  // Play a random jingle at the start of each video
  await playRandomSound(guild, channel);

  logger.info(`[${guild.id}] Playing: ${video.title}`);

  // Reuse the existing connection if we're already in the right channel,
  // otherwise destroy the old one and create a new connection.
  const alreadyHere = session.connection
    && session.connection.joinConfig.channelId === channel.id
    && session.connection.state.status !== VoiceConnectionStatus.Destroyed;

  if (!alreadyHere) {
    const oldConn = session.connection;
    session.connection = null;
    if (oldConn) {
      try { oldConn.destroy(); } catch { /* already gone */ }
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
        if (session.connection === thisConnection) {
          logger.info(`[${guild.id}] Voice reconnecting after a network blip…`);
        }
      } catch {
        if (session.connection !== thisConnection) return;
        logger.warn(`[${guild.id}] Voice connection lost.`);
        try { thisConnection.destroy(); } catch { /* already gone */ }
        session.connection = null;
        freezeProgress(session);
        stopProgressAutosave(session);
        saveState(session);

        if (session.continuous && !session.manualStop) {
          logger.info(`[${guild.id}] Will try to rejoin #${channel.name} in ${RECONNECT_DELAY_MS / 1000}s…`);
          setTimeout(() => rejoinAndResume(guild, channel), RECONNECT_DELAY_MS);
        }
      }
    });

    try {
      await entersState(session.connection, VoiceConnectionStatus.Ready, 60_000);
      logger.info(`[${guild.id}] Connected to #${channel.name}`);
    } catch (err) {
      try { session.connection.destroy(); } catch { /* already gone */ }
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

  // Guard both handlers against stale events firing after `player` has
  // already been replaced by a newer track (avoids double-advancing).
  player.on(AudioPlayerStatus.Idle, () => {
    if (session.player !== player) return;
    if (session.interjecting) return; // a sound effect is taking over — don't advance the queue
    logger.info(`[${guild.id}] Track finished.`);
    onTrackFinished(guild, channel);
  });

  player.on('error', (err) => {
    if (session.player !== player) return;
    if (session.interjecting) return;
    logger.error(`[${guild.id}] Player error:`, err.message);
    // Treat a player-level error (e.g. yt-dlp crashed mid-stream) the same
    // as the track finishing, so continuous mode recovers instead of
    // silently going quiet.
    onTrackFinished(guild, channel);
  });

  session.connection.subscribe(player);
  player.play(resource);

  // Start the live progress clock for this segment and begin autosaving it.
  session.segmentStartOffset = startSeconds;
  session.segmentStartedAt = Date.now();
  session.current = { ...video, progressSeconds: startSeconds };
  startProgressAutosave(session);
  saveState(session);
  updateNowPlayingMessage(session).catch(() => {});
  playerEvents.emit('trackChange', { guildId: guild.id, video: session.current, paused: false });

  // Only count as a "play" for the /top leaderboard when this is genuinely
  // a new track starting from the top — not a volume-change restart, a
  // reconnect resume, or resuming the main track after a sound effect
  // (those all pass countPlay: false), and not a mid-track resume from a
  // saved position (startSeconds > 0).
  if (countPlay && startSeconds === 0) {
    recordPlay(video);
  }

  // Best-effort enrichment (duration/thumbnail/views/upload date) for the
  // embed — doesn't block playback starting, just updates the card a moment
  // later.
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

/**
 * Called when a track ends, errors, or is skipped.
 * In continuous mode this keeps retrying with backoff instead of giving
 * up on the first failure, so a transient network/API hiccup doesn't
 * silence a 24/7 stream.
 */
async function onTrackFinished(guild, channel) {
  const session = getSession(guild.id);
  if (session.advancing) return; // a transition is already in flight
  session.advancing = true;

  try {
    if (!session.continuous) {
      logger.info(`[${guild.id}] Continuous mode off. Stopping.`);
      stopPlayback(guild.id, { manual: false });
      return;
    }

    // If the track finished in less than 10 seconds, it's likely a broken
    // URL or very short clip. Skip it from the recent list and wait a bit
    // before trying the next one to avoid rapid-fire switching.
    if (session.segmentStartedAt) {
      const playedSeconds = (Date.now() - session.segmentStartedAt) / 1000;
      if (playedSeconds < 10 && session.current?.videoId) {
        logger.warn(`[${guild.id}] Track played only ${Math.round(playedSeconds)}s — likely broken URL, skipping.`);
        trackRecent(session, session.current.videoId);
        await sleep(3000);
      }
    }

    let attempt = 0;
    while (session.continuous && !session.manualStop) {
      try {
        // Play a random jingle before the next video
        await playRandomSound(guild, channel);

        const next = session.queue.shift()
          || await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
        session.current = next;
        trackRecent(session, next.videoId);
        await connectAndPlay(guild, channel, next);
        prefetchQueue(session).catch((err) => logger.error('Prefetch failed:', err.message));
        return;
      } catch (err) {
        attempt += 1;
        const delay = Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_MAX_DELAY_MS);
        logger.error(
          `[${guild.id}] Failed to play next video (attempt ${attempt}):`,
          err.message,
          `retrying in ${delay / 1000}s…`,
        );
        await sleep(delay);
      }
    }
  } finally {
    session.advancing = false;
  }
}

/**
 * Rejoin the voice channel after an unexpected drop and resume where we
 * left off. Keeps retrying (with backoff) as long as continuous mode is
 * still meant to be running and the user hasn't issued /stop.
 */
async function rejoinAndResume(guild, channel, attempt = 1) {
  const session = getSession(guild.id);
  if (!session.continuous || session.manualStop) return;

  try {
    const freshChannel = await guild.channels.fetch(channel.id).catch(() => channel);
    if (!freshChannel || (freshChannel.isVoiceBased && !freshChannel.isVoiceBased())) {
      logger.warn(`[${guild.id}] Voice channel no longer available, stopping.`);
      stopPlayback(guild.id, { manual: false });
      return;
    }

    const video = session.current
      || await getRandomVideo(config.channelId, config.youtubeApiKey, session.recentIds);
    await connectAndPlay(guild, freshChannel, video, { countPlay: false });
    prefetchQueue(session).catch((err) => logger.error('Prefetch failed:', err.message));
    logger.info(`[${guild.id}] Rejoined and resumed playback.`);
  } catch (err) {
    const delay = Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_MAX_DELAY_MS);
    logger.error(`[${guild.id}] Rejoin failed:`, err.message, `retrying in ${delay / 1000}s…`);
    // A handful of failed attempts is normal for a brief network blip and
    // not worth paging anyone about. Past that, it's likely something a
    // human needs to look at (PC asleep, router down, etc.) — say so once.
    if (attempt === 5) {
      notify(
        '🟡 Voice Rejoin Struggling',
        `Guild \`${guild.id}\` has failed to rejoin its voice channel ${attempt} times in a row.\n`
        + `Last error: \`${err.message.slice(0, 300)}\`\nStill retrying automatically.`,
        'warn',
      ).catch(() => {});
    }
    setTimeout(() => rejoinAndResume(guild, channel, attempt + 1), delay);
  }
}

function killProcesses(session) {
  if (session.ffmpegProcess) {
    try { session.ffmpegProcess.kill(); } catch { /* already dead */ }
    session.ffmpegProcess = null;
  }
  if (session.resolveProcess) {
    try { session.resolveProcess.kill(); } catch { /* already dead */ }
    session.resolveProcess = null;
  }
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Resolve a direct audio URL via `yt-dlp -g`, then pipe it through ffmpeg
 * to produce raw PCM that @discordjs/voice can consume without any
 * decoding overhead.
 *
 * - Volume is applied via ffmpeg's `volume` filter (avoids inlineVolume lag)
 * - Seeking uses `-ss` as an input option so ffmpeg/CDN skip ahead via HTTP
 *   range requests (fast resume mid-track)
 * - Returns { stream, ffmpegProcess } so the caller can read stdout
 */
function createAudioStream(session, youtubeUrl, startSeconds = 0, volume = 100) {
  return new Promise((resolve, reject) => {
    const resolveProcess = spawn('yt-dlp', [
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '-g',
      youtubeUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    session.resolveProcess = resolveProcess;

    let stdout = '';
    let stderr = '';
    resolveProcess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    resolveProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    resolveProcess.on('error', (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)));

    resolveProcess.on('close', (code) => {
      session.resolveProcess = null;
      if (code !== 0) {
        reject(new Error(`yt-dlp failed to resolve the audio URL (code ${code}): ${stderr.trim().slice(-300)}`));
        return;
      }

      const directUrl = stdout.trim().split('\n')[0];
      if (!directUrl) {
        reject(new Error('yt-dlp did not return a playable URL.'));
        return;
      }

      // Build ffmpeg args: seek → input → volume → output PCM s16le 48kHz stereo
      const ffmpegArgs = [];
      if (startSeconds > 0) {
        ffmpegArgs.push('-ss', String(startSeconds));
      }
      ffmpegArgs.push(
        '-i', directUrl,
        '-af', `volume=${volume / 100}`,
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      );

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      ffmpegProcess.stderr.on('data', () => {}); // suppress ffmpeg stderr

      ffmpegProcess.on('error', (err) => {
        reject(new Error(`Failed to start ffmpeg: ${err.message}`));
      });

      ffmpegProcess.on('close', (code) => {
        // Only warn if this was the active ffmpeg (not intentionally killed)
        if (code !== 0 && code !== null && session.ffmpegProcess === ffmpegProcess) {
          logger.warn(`ffmpeg exited with code ${code}`);
        }
      });

      logger.info(
        startSeconds > 0
          ? `Resuming from ${formatTime(startSeconds)}…`
          : 'Streaming audio…',
      );
      resolve({ stream: ffmpegProcess.stdout, ffmpegProcess });
    });
  });
}
