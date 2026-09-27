/**
 * engine.ts — the audio engine.
 *
 * Responsibilities:
 *   - Join voice channels and manage the VoiceConnection
 *   - Create an AudioPlayer and stream playback
 *   - Advance automatically between tracks
 *   - Rejoin after a network drop
 *   - Preload the next track so transitions are gapless
 *   - Crossfade between tracks when enabled
 *   - playRandom, playLatest, playVideo, resume
 *
 * Cost model: exactly one yt-dlp + one ffmpeg per track, plus one extra pair
 * while a preload is held. The previous implementation spawned three yt-dlp
 * processes per track (pre-validation, live probe, stream), and threw away the
 * preloaded audio at the boundary.
 *
 * Crossfade mechanics: @discordjs/voice destroys a resource's stream when the
 * player is given a new resource, so a mixer cannot be introduced by swapping
 * `player.play(...)`. Subscribing the *connection* to a second player does not
 * destroy the outgoing player's resource, so that is the swap used here: the
 * outgoing track keeps streaming into the mixer while the connection is
 * re-pointed at it.
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
import { createAudioStream, isLiveStream, getActiveProcessCount } from '../streaming.js';
import type { AudioStreamHandle } from '../streaming.js';
import {
  getSession, saveState,
  getElapsedSeconds, freezeProgress,
  startProgressAutosave, stopProgressAutosave,
  popFromQueue, migrateSessionToQueue, syncQueueWithCatalog,
  restoreLastVideo, addFailedId,
  takePreload, discardPreload, releaseTape, isPreloadUsable,
  takePendingHandle, discardPending, clearPreloadTimer,
} from '../session.js';
import { playerEvents, stopPlayback } from './controls.js';
import { playRandomJingle, playStationId } from './jingles.js';
import { triggerUiUpdate } from './ui-updater.js';
import { CrossfadeReadable, crossfadeStartTime } from './crossfade.js';
import { NOTIFY } from '../../lang.js';

const logger = createLogger('audio');

const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;
const RECONNECT_DELAY_MS = 10_000;
const PRELOAD_LEAD_SECONDS = 20;
const NETWORK_CHECK_INTERVAL_MS = 120_000;
/**
 * How many times a rejoin may fail before the radio gives up. The ladder
 * backs off to 60s, so this is roughly 30 minutes of sustained failure — far
 * past any plausible network outage, but well short of retrying forever
 * against a guild the bot is no longer in.
 */
const MAX_REJOIN_ATTEMPTS = 40;

/** Crossfade length in seconds. Set CROSSFADE_SECONDS=0 to hard-switch. */
const CROSSFADE_SECONDS = Math.max(0, Number(process.env.CROSSFADE_SECONDS ?? 4) || 0);
/** Tracks shorter than this are never crossfaded. */
const MIN_CROSSFADE_TRACK_SECONDS = 20;
/**
 * How early (before the crossfade starts) the outgoing track is recorded.
 * The audio player consumes its stream in real time, so the tail we want to
 * blend has to be copied out *before* the player drains it.
 */
const CROSSFADE_TAPE_MARGIN_SECONDS = 3;
/** How long a crossfade may take to produce audio before we abandon it. */
const CROSSFADE_WATCHDOG_MS = 25_000;
/** Consecutive stream-start failures before a video is written off. */
const MAX_TRACK_ATTEMPTS = 3;

function crossfadeEnabled(): boolean {
  return CROSSFADE_SECONDS > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredDelay(baseMs: number, attempt: number): number {
  const delay = Math.min(baseMs * attempt, RETRY_MAX_DELAY_MS);
  return Math.floor(delay * (0.8 + Math.random() * 0.4));
}

/** Quick network check — DNS lookup to verify internet is available. */
async function isNetworkUp(): Promise<boolean> {
  try {
    const { lookup } = await import('node:dns');
    return new Promise((resolve) => {
      lookup('discord.com', (err) => resolve(!err));
    });
  } catch {
    return false;
  }
}

function isNetworkError(err: Error): boolean {
  const msg = err?.message || '';
  return /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|socket hang up/i.test(msg);
}

/**
 * Wait for a long time, but only while the network is down. Returns as soon as
 * connectivity returns, otherwise loops on the check interval.
 */
async function waitForNetwork(label: string): Promise<void> {
  logger.warn(`${label} — checking every ${NETWORK_CHECK_INTERVAL_MS / 1000}s...`);
  for (;;) {
    await sleep(NETWORK_CHECK_INTERVAL_MS);
    if (await isNetworkUp()) {
      logger.info(`${label} — network is back.`);
      return;
    }
  }
}

/**
 * Dynamic timeout based on video duration: short videos get shorter timeouts,
 * long videos longer ones.
 */
function dynamicTimeout(durationSeconds: number | null | undefined, pct: number, minMs: number, maxMs: number): number {
  if (!durationSeconds || durationSeconds <= 0) return minMs;
  const computed = Math.floor(durationSeconds * 1000 * pct);
  return Math.max(minMs, Math.min(maxMs, computed));
}

async function enrichWithDetails(video: any) {
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

/** Release everything the session is currently holding on to. */
function releaseSessionAudio(session: any): void {
  clearCrossfadeTimers(session);
  clearPreloadTimer(session);
  discardPreload(session);
  discardPending(session);
  if (session.outgoingPlayer) {
    try { session.outgoingPlayer.stop(true); } catch { /* already gone */ }
    session.outgoingPlayer = null;
  }
  if (session.activeHandle) {
    try { session.activeHandle.kill(); } catch { /* already gone */ }
    session.activeHandle = null;
  }
}

/**
 * Stop the player and stream the session is playing right now, leaving the
 * voice connection alone.
 *
 * Every path that replaces `session.player` or `session.activeHandle` has to
 * come through here. Assigning over the references is not enough: the previous
 * AudioPlayer stays subscribed to the connection and keeps its resource, and
 * the yt-dlp + ffmpeg pair behind it stays alive with ffmpeg blocked writing
 * into a pipe nobody will ever read. That is an unbounded leak of both process
 * slots and memory on a bot that plays continuously.
 */
function teardownActivePlayback(session: any, keepHandle: AudioStreamHandle | null | undefined = null): void {
  if (session.streamWatchdog) {
    clearInterval(session.streamWatchdog);
    session.streamWatchdog = null;
  }
  const player = session.player;
  session.player = null;
  session.resource = null;
  if (player) {
    try { player.stop(true); } catch { /* already gone */ }
  }
  const handle = session.activeHandle;
  if (handle && handle !== keepHandle) {
    try { handle.kill(); } catch { /* already gone */ }
  }
  if (handle) session.activeHandle = null;

  // This track is committed, so any candidate chosen for a *different*
  // transition is abandoned. The normal path has already handed its handle
  // over via `keepHandle`; this covers the restarts, which do not.
  discardPending(session);
}

// ---------------------------------------------------------------------------
// Preload — resolve the next track's audio ahead of time
// ---------------------------------------------------------------------------

/**
 * Resolve and buffer the next track so the boundary is instant.
 *
 * The returned handle stays live and paused: ffmpeg blocks on a full pipe after
 * a fraction of a second, holding real decoded audio ready to adopt. The old
 * implementation spawned yt-dlp, read one chunk, then killed the process at the
 * boundary and re-resolved from scratch — paying the cost without using it.
 */
async function preloadNextTrack(session: any): Promise<void> {
  if (session.preloaded) return;
  const nextId = session.queue[0];
  if (!nextId) return;

  let catalog: any[];
  try {
    catalog = await getVideos();
  } catch (err: any) {
    logger.debug(`[${session.guildId}] Preload catalog lookup failed: ${err.message}`);
    return;
  }

  // Guard against a slow lookup resolving after the track already advanced.
  if (session.queue[0] !== nextId || session.preloaded) return;

  const next = catalog.find((v) => v.videoId === nextId);
  if (!next?.url) return;

  let handle: AudioStreamHandle;
  try {
    handle = await createAudioStream({
      url: next.url,
      volume: session.volume,
      durationSeconds: next.durationSeconds,
      // The crossfade mixer owns the envelope when crossfading; two fade
      // envelopes multiplied together would cancel the transition out.
      fades: !crossfadeEnabled(),
    });
  } catch (err: any) {
    logger.debug(`[${session.guildId}] Preload failed for "${next.title}": ${err.message}`);
    return;
  }

  // Wait for a useful amount of audio, so the boundary never has to wait.
  const deadline = Date.now() + 10_000;
  while (handle.bytesProduced < 96_000 && !handle.ended && Date.now() < deadline) {
    await sleep(50);
  }

  if (!isPreloadUsable({ video: next, handle, createdAt: Date.now() })) {
    logger.debug(`[${session.guildId}] Preload produced no usable audio — discarding.`);
    try { handle.kill(); } catch { /* already gone */ }
    return;
  }

  if (session.queue[0] !== nextId) {
    // The queue moved on while we were buffering; this audio is now wrong.
    try { handle.kill(); } catch { /* already gone */ }
    return;
  }

  session.preloaded = { video: next, handle, createdAt: Date.now() };
  logger.info(`[${session.guildId}] Preloaded "${next.title}" (${(handle.bytesProduced / 1024).toFixed(0)}KB buffered)`);
}

/** Arm the preload for the tail of a track, when it is long enough to matter. */
function schedulePreload(session: any, video: any): void {
  clearPreloadTimer(session);
  if (!crossfadeEnabled()) return;
  if (!video?.durationSeconds || video.durationSeconds <= PRELOAD_LEAD_SECONDS) return;

  const leadMs = Math.max(5_000, (video.durationSeconds - PRELOAD_LEAD_SECONDS) * 1000);
  // The handle is kept so the timer can be cancelled. A preload armed for a
  // three-hour track used to survive every /stop, volume change and skip in
  // between, and a second one could be armed on top of it.
  session.preloadTimer = setTimeout(() => {
    session.preloadTimer = null;
    if (session.manualStop || !session.continuous) return;
    if (session.current?.videoId !== video.videoId) return;
    if (session.preloaded) return;
    preloadNextTrack(session).catch((e) => logger.debug(`[${session.guildId}] Preload failed: ${e.message}`));
  }, leadMs);
}

// ---------------------------------------------------------------------------
// Public: playRandom, playLatest, playVideo, resume
// ---------------------------------------------------------------------------

export async function playLatest(guild: any, channel: any) {
  const session = getSession(guild.id);
  await stopPlayback(guild.id, { manual: false });

  const video = await getLatestVideo();
  session.mode = 'latest';
  session.continuous = true;
  session.current = video;
  session.playedIds.add(video.videoId);

  const catalog = await getVideos();
  await migrateSessionToQueue(session, catalog);
  syncQueueWithCatalog(session, catalog);

  await connectAndPlay(guild, channel, video);
  return session.current;
}

export async function playVideo(guild: any, channel: any, video: any) {
  const session = getSession(guild.id);
  await stopPlayback(guild.id, { manual: false });

  session.mode = 'manual';
  session.continuous = true;
  session.current = video;
  session.playedIds.add(video.videoId);

  const catalog = await getVideos();
  await migrateSessionToQueue(session, catalog);
  syncQueueWithCatalog(session, catalog);

  await connectAndPlay(guild, channel, video);
  return session.current;
}

export async function playRandom(guild: any, channel: any) {
  const session = getSession(guild.id);
  await stopPlayback(guild.id, { manual: false });

  session.mode = 'random';
  session.continuous = true;

  const catalog = await getVideos();
  await migrateSessionToQueue(session, catalog);
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

export async function resume(guild: any, channel: any) {
  const session = getSession(guild.id);
  const savedVideo = session.current || await restoreLastVideo(guild.id);
  const savedElapsed = session.current
    ? Math.floor(getElapsedSeconds(session))
    : (savedVideo?.progressSeconds || 0);

  await stopPlayback(guild.id, { manual: false });

  if (!savedVideo) throw new Error('لا يوجد مقطع سابق للاستكمال.');

  session.mode = 'resume';
  session.continuous = true;
  session.current = { ...savedVideo, progressSeconds: savedElapsed };

  await connectAndPlay(guild, channel, session.current);
  return session.current;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function ensureConnection(guild: any, channel: any, session: any): Promise<void> {
  const alreadyHere = session.connection
    && session.connection.joinConfig.channelId === channel.id
    && session.connection.state.status !== VoiceConnectionStatus.Destroyed;

  if (alreadyHere) {
    logger.info(`[${guild.id}] Already connected to #${channel.name}, reusing connection.`);
    return;
  }

  const oldConn = session.connection;
  session.connection = null;
  if (oldConn) { try { oldConn.destroy(); } catch { /* already gone */ } }

  session.connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const thisConnection = session.connection;

  /**
   * The voice path is gone and will not come back on its own.
   *
   * This is the only recovery path in the engine, so it must be reachable from
   * every terminal transition. Listening to `Disconnected` alone leaves a real
   * gap: when the connection dies from `Signalling` — a dropped UDP path the
   * library could not renegotiate, or a guild that stopped being reachable —
   * no `Disconnected` event ever fires. `session.connection` keeps pointing at
   * a dead object, the dashboard keeps reporting "connected", ffmpeg keeps
   * producing audio, and the radio is silent with no indication of why.
   */
  const recoverConnection = (reason: string) => {
    if (session.connection !== thisConnection) return;
    if (session.recovering) return;
    session.recovering = true;

    logger.warn(`[${guild.id}] ${reason}`);
    if (thisConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      try { thisConnection.destroy(); } catch { /* already gone */ }
    }
    session.connection = null;
    freezeProgress(session);
    stopProgressAutosave(session);
    saveState(session).catch(() => {});

    if (session.continuous && !session.manualStop) {
      logger.info(`[${guild.id}] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
      session.rejoinTimer = setTimeout(() => {
        session.rejoinTimer = null;
        rejoinAndResume(guild, channel).catch(() => {});
      }, RECONNECT_DELAY_MS);
    }
  };

  thisConnection.on(VoiceConnectionStatus.Signalling, () => {
    if (session.connection !== thisConnection) return;
    logger.debug(`[${guild.id}] Voice connection signalling — renegotiating after a network blip.`);
  });

  thisConnection.on(VoiceConnectionStatus.Destroyed, () => {
    recoverConnection('Voice connection destroyed.');
  });

  thisConnection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (session.connection !== thisConnection) return;
    try {
      // Both of these are the transient states the library walks through while
      // it recovers by itself. Reaching either one means this is a blip, not
      // an outage, and the `catch` below is the wrong response.
      await Promise.race([
        entersState(thisConnection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(thisConnection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      recoverConnection('Voice connection lost.');
    }
  });

  try {
    await entersState(session.connection, VoiceConnectionStatus.Ready, 60_000);
    // A live connection clears any recovery in progress, so a later disconnect
    // is handled from scratch.
    session.recovering = false;
    logger.info(`[${guild.id}] Connected to #${channel.name}`);
  } catch (err: any) {
    try { session.connection.destroy(); } catch { /* already gone */ }
    session.connection = null;
    throw new Error(`تعذّر الاتصال بالقناة الصوتية: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Player supervision — stall and dead-stream detection
// ---------------------------------------------------------------------------

/**
 * Watch the active handle for silence. Polling `bytesProduced` keeps us out of
 * flowing mode; attaching a `data` listener to the PCM stream would consume
 * audio the player has not read yet.
 */
function superviseStream(session: any, player: any, handle: AudioStreamHandle, video: any, guild: any, channel: any): void {
  const stallTimeoutMs = dynamicTimeout(video.durationSeconds, 0.005, 60_000, 180_000);
  const deadStreamTimeout = dynamicTimeout(video.durationSeconds, 0.01, 60_000, 300_000);
  const checkIntervalMs = Math.max(15_000, Math.floor(deadStreamTimeout / 6));

  logger.info(`[${guild.id}] Stall timeout ${Math.round(stallTimeoutMs / 1000)}s, dead-stream timeout ${Math.round(deadStreamTimeout / 1000)}s`);

  let lastBytes = handle.bytesProduced;
  let lastProgressAt = Date.now();

  const interval = setInterval(() => {
    if (session.player !== player) { clearInterval(interval); return; }
    if (!session.connection || session.connection.state.status === VoiceConnectionStatus.Destroyed) {
      clearInterval(interval);
      return;
    }

    const bytes = handle.bytesProduced;
    if (bytes !== lastBytes) {
      lastBytes = bytes;
      lastProgressAt = Date.now();
    }
    if (handle.ended) { clearInterval(interval); return; }

    const playerStatus = player.state?.status;
    const stalled = playerStatus === AudioPlayerStatus.AutoPaused
      || playerStatus === AudioPlayerStatus.Buffering
      || playerStatus === AudioPlayerStatus.Playing;

    if (!stalled) return;

    const elapsed = Date.now() - lastProgressAt;
    const limit = playerStatus === AudioPlayerStatus.Playing ? deadStreamTimeout : stallTimeoutMs;
    if (elapsed <= limit) return;

    session.deadStreamRestarts = (session.deadStreamRestarts || 0) + 1;
    if (session.deadStreamRestarts <= MAX_TRACK_ATTEMPTS) {
      logger.warn(`[${guild.id}] No audio data for ${Math.round(elapsed / 1000)}s — restarting track (${session.deadStreamRestarts}/${MAX_TRACK_ATTEMPTS})...`);
      clearInterval(interval);
      restartCurrentTrack(guild, channel, session);
    } else {
      logger.warn(`[${guild.id}] Stream stalled ${session.deadStreamRestarts}x — skipping this track.`);
      clearInterval(interval);
      session.deadStreamRestarts = 0;
      onTrackFinished(guild, channel);
    }
  }, checkIntervalMs);

  if (session.streamWatchdog) clearInterval(session.streamWatchdog);
  session.streamWatchdog = interval;
}

/** Restart the current track from where it got to, up to a bounded number of times. */
function restartCurrentTrack(guild: any, channel: any, session: any): void {
  const current = session.current;
  if (!current) { onTrackFinished(guild, channel); return; }

  const elapsed = Math.floor(getElapsedSeconds(session));
  session.current = { ...current, progressSeconds: elapsed };
  discardPreload(session);
  connectAndPlay(guild, channel, session.current, { countPlay: false })
    .catch(() => onTrackFinished(guild, channel));
}

// ---------------------------------------------------------------------------
// Core: connectAndPlay
// ---------------------------------------------------------------------------

export interface ConnectAndPlayOptions {
  /** Record the play in stats. False for restarts and reconnects. */
  countPlay?: boolean;
  /** Adopt an already-buffered stream instead of spawning yt-dlp again. */
  handle?: AudioStreamHandle;
  /** Skip the jingle/station-ID (used by restarts and the crossfade handoff). */
  interlude?: boolean;
}

export async function connectAndPlay(
  guild: any,
  channel: any,
  video: any,
  { countPlay = true, handle: providedHandle, interlude = true }: ConnectAndPlayOptions = {},
): Promise<void> {
  const session = getSession(guild.id);
  session.guild = guild;
  session.channel = channel;

  if (!guild.available || !channel) {
    logger.warn(`[${guild.id}] Guild or channel unavailable — skipping play.`);
    return;
  }

  // Take a ticket. Overlapping requests are easy to produce — a dashboard
  // `resume`, a voice-state auto-start and the scheduler all reach here, and
  // each spends up to 60s in `ensureConnection` before it even spawns a stream.
  // Without this, both would run to completion and the loser's AudioPlayer
  // stayed subscribed alongside the winner's, with two process pairs for one
  // slot. A stop bumps the token too, so a `/stop` during a 45s stream spawn
  // cancels it instead of being overwritten by it.
  const token = ++session.playToken;
  const superseded = () => session.playToken !== token;

  logger.info(`[${guild.id}] Playing: ${video.title}`);
  await ensureConnection(guild, channel, session);
  if (superseded()) {
    logger.debug(`[${guild.id}] Superseded while connecting — abandoning "${video.title}".`);
    return;
  }

  // A new track invalidates any pending transition and the outgoing preload.
  clearCrossfadeTimers(session);
  clearPreloadTimer(session);
  releaseOutgoingTape(session);
  session.crossfading = false;
  if (session.outgoingPlayer) {
    try { session.outgoingPlayer.stop(true); } catch { /* already gone */ }
    session.outgoingPlayer = null;
  }

  if (interlude && countPlay) {
    await playRandomJingle(guild, channel);
    // playStationId returns a boolean (it handles its own errors internally),
    // so it must not be awaited as a promise.
    try { playStationId(guild, channel); } catch { /* station ID is optional */ }
  }
  if (superseded()) return;

  // A buffered stream always begins at zero — that is where it was decoded
  // from — so the resume point is only meaningful for a freshly spawned one.
  const startSeconds = providedHandle ? 0 : Math.max(0, Math.floor(video.progressSeconds || 0));

  // Release whatever was playing before. This has to happen after the jingle,
  // which borrows the session's current player, but before the new stream is
  // spawned so the two process pairs never overlap.
  teardownActivePlayback(session, providedHandle);

  const handle = providedHandle ?? await createAudioStream({
    url: video.url,
    startSeconds,
    volume: session.volume,
    durationSeconds: video.durationSeconds,
    fades: !crossfadeEnabled(),
  });

  // The one checkpoint that has something to clean up: a handle spawned for a
  // request that has since been superseded would otherwise be a live
  // yt-dlp + ffmpeg pair that nothing ever reads.
  if (superseded()) {
    logger.debug(`[${guild.id}] Superseded while streaming — killing handle for "${video.title}".`);
    if (!providedHandle) {
      try { handle.kill(); } catch { /* already gone */ }
    }
    return;
  }

  session.activeHandle = handle;

  const resource = createAudioResource(handle.stream, { inputType: StreamType.Raw });
  session.resource = resource;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  session.player = player;
  session.paused = false;
  session.isLive = false;
  session.deadStreamRestarts = 0;

  attachPlayerEvents(session, player, guild, channel);

  session.connection.subscribe(player);
  player.play(resource);

  session.segmentStartOffset = startSeconds;
  session.segmentStartedAt = Date.now();
  session.current = { ...video, progressSeconds: startSeconds };
  startProgressAutosave(session);
  await saveState(session);

  superviseStream(session, player, handle, video, guild, channel);

  triggerUiUpdate(session).catch(() => {});
  playerEvents.emit('trackChange', { guildId: guild.id, video: session.current, paused: false });

  schedulePreload(session, video);
  armCrossfade(session, guild, channel, video, handle);

  if (countPlay && startSeconds === 0) recordPlay(video);

  // Enrich metadata and detect live streams in the background.
  enrichWithDetails(video).then((enriched) => {
    if (session.current?.videoId === enriched.videoId) {
      session.current = {
        ...session.current,
        durationSeconds: enriched.durationSeconds,
        thumbnail: enriched.thumbnail,
        viewCount: enriched.viewCount,
        publishedAt: enriched.publishedAt,
      };
      // A track whose real duration only becomes known now can still crossfade.
      armCrossfade(session, guild, channel, session.current, handle);
    }
    triggerUiUpdate(session).catch(() => {});
  }).catch(() => {});

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

/** Wire the shared player lifecycle handlers. */
function attachPlayerEvents(session: any, player: any, guild: any, channel: any): void {
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

  player.on('error', (err: Error) => {
    if (session.player !== player) return;
    if (session.interjecting) return;
    logger.error(`[${guild.id}] Player error: ${err.message}`);
    if (!session.connection || session.connection.state.status === VoiceConnectionStatus.Destroyed) return;
    onTrackFinished(guild, channel);
  });
}

// ---------------------------------------------------------------------------
// Crossfade
// ---------------------------------------------------------------------------

/** Release the recorded copy of the outgoing track, if any. */
function releaseOutgoingTape(session: any): void {
  releaseTape(session);
}

/** Crossfade timing, injectable so tests can run without waiting real minutes. */
export interface CrossfadeTimings {
  /** Blend length in seconds. */
  fadeSeconds: number;
  /** Tracks shorter than this are never crossfaded. */
  minTrackSeconds: number;
  /** How long before the blend the tail starts recording. */
  tapeMarginSeconds: number;
}

const DEFAULT_CROSSFADE_TIMINGS: CrossfadeTimings = {
  fadeSeconds: CROSSFADE_SECONDS,
  minTrackSeconds: MIN_CROSSFADE_TRACK_SECONDS,
  tapeMarginSeconds: CROSSFADE_TAPE_MARGIN_SECONDS,
};

/**
 * Decide whether this track can be crossfaded, and arm the timers.
 *
 * Two timers are needed, and the order matters: the outgoing track must be
 * recorded starting a few seconds *before* the blend begins, because the audio
 * player consumes its stream as it plays and that audio cannot be re-read
 * later. Safe to call repeatedly — it replaces any previously armed timers.
 */
function armCrossfade(
  session: any,
  guild: any,
  channel: any,
  video: any,
  handle: AudioStreamHandle,
  timings: CrossfadeTimings = DEFAULT_CROSSFADE_TIMINGS,
): void {
  clearCrossfadeTimers(session);
  if (timings.fadeSeconds <= 0) return;
  if (!session.continuous || session.manualStop) return;
  if (session.crossfading) return;
  if (session.isLive) return;
  if (handle.ended) return;

  const duration = video?.durationSeconds;
  if (!duration || duration < timings.minTrackSeconds) return;

  const secondsLeft = duration - getElapsedSeconds(session);
  const fadeSec = Math.min(timings.fadeSeconds, secondsLeft / 2);
  if (fadeSec < 1) return;

  // Start recording the tail. Guarded so a stale timer cannot attach a second
  // tape over one that is already recording.
  const tapeInSec = secondsLeft - (fadeSec + timings.tapeMarginSeconds);
  if (tapeInSec > 0) {
    session.tapeTimer = setTimeout(() => {
      session.tapeTimer = null;
      if (session.crossfading) return;
      if (session.outgoingTape) return;
      if (handle.ended || handle.stream.destroyed) return;
      session.outgoingTape = handle.tap();
      session.outgoingTapeHandle = handle;
      logger.debug(`[${session.guildId}] Recording outgoing track for crossfade.`);
    }, Math.max(0, tapeInSec * 1000));
  }

  // Blend.
  const blendInSec = Math.max(0, crossfadeStartTime(secondsLeft, fadeSec));
  session.crossfadeTimer = setTimeout(() => {
    session.crossfadeTimer = null;
    beginCrossfade(guild, channel, fadeSec).catch((err) => {
      logger.warn(`[${session.guildId}] Crossfade failed, falling back to a hard switch: ${err.message}`);
      onTrackFinished(guild, channel);
    });
  }, blendInSec * 1000);
}

/**
 * Cancel the pending tape/blend timers.
 *
 * Deliberately does NOT release the tape: when this runs at the end of a
 * crossfade, the mixer is still reading it. The tape is owned by whichever
 * transition created it and released on completion, on a new track, or on stop.
 */
function clearCrossfadeTimers(session: any): void {
  if (session.crossfadeTimer) {
    clearTimeout(session.crossfadeTimer);
    session.crossfadeTimer = null;
  }
  if (session.tapeTimer) {
    clearTimeout(session.tapeTimer);
    session.tapeTimer = null;
  }
}

/**
 * Blend the current track into the next one and re-point the connection at the
 * mixer.
 *
 * What the library actually does, verified against @discordjs/voice 0.19:
 *
 *  - `createAudioResource` wraps the PCM in an Opus encoder, so `playStream` is
 *    the encoder, not our stream. `player.play(other)` destroys the *encoder*,
 *    leaving the PCM source alive — but the player has drained that PCM in real
 *    time, so the audio we want to blend is already gone. Hence the **tape**: a
 *    paused copy taken a few seconds before the blend.
 *  - `connection.subscribe(other)` re-points the voice connection without
 *    touching the outgoing player's resource, so it is the safe way to swap.
 *  - Once swapped, the outgoing chain has no reader. Left alone, its PassThrough
 *    fills, back-pressures ffmpeg, and starves the mixer — so the outgoing track
 *    is torn down immediately. The tape already holds the whole blend window, so
 *    nothing is lost.
 */
async function beginCrossfade(guild: any, channel: any, fadeSec: number): Promise<void> {
  const session = getSession(guild.id);
  if (session.crossfading) return;
  if (!session.continuous || session.manualStop) return;
  if (!session.player || !session.connection) return;
  if (session.connection.state.status !== VoiceConnectionStatus.Ready) return;
  if (session.isLive) return;

  const outgoingHandle: AudioStreamHandle | null = session.activeHandle;
  if (!outgoingHandle || outgoingHandle.ended) return;

  if (session.crossfadeTimer) {
    clearTimeout(session.crossfadeTimer);
    session.crossfadeTimer = null;
  }

  const tape = session.outgoingTape;
  if (!tape || tape.destroyed) {
    // Nothing was recorded (e.g. the duration only became known too late to
    // start the tape). Fall back to a plain transition rather than blending
    // silence into the stream.
    logger.debug(`[${session.guildId}] No recorded tail for crossfade — using a hard switch.`);
    onTrackFinished(guild, channel);
    return;
  }

  session.crossfading = true;

  const nextVideo = await selectNextVideo(session);
  if (!nextVideo) {
    session.crossfading = false;
    return;
  }

  // Prefer the preloaded stream: this is the whole point of preloading.
  let nextHandle: AudioStreamHandle;
  const preload = takePreload(session);
  if (preload && preload.video.videoId === nextVideo.videoId) {
    nextHandle = preload.handle;
  } else {
    if (preload) preload.handle.kill();
    try {
      nextHandle = await createAudioStream({
        url: nextVideo.url,
        volume: session.volume,
        durationSeconds: nextVideo.durationSeconds,
        fades: false,
      });
    } catch (err: any) {
      session.crossfading = false;
      logger.warn(`[${session.guildId}] Crossfade could not start "${nextVideo.title}": ${err.message}`);
      onTrackFinished(guild, channel);
      return;
    }
  }

  if (session.manualStop || !session.continuous) {
    nextHandle.kill();
    releaseOutgoingTape(session);
    session.crossfading = false;
    return;
  }

  const mixer = new CrossfadeReadable(tape as any, nextHandle.stream as any, {
    durationSec: fadeSec,
    onCrossfadeComplete: () => {
      // The outgoing track has fully faded; nothing left to keep.
      releaseOutgoingTape(session);
    },
  });

  const mixResource = createAudioResource(mixer, { inputType: StreamType.Raw });
  const mixPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  // The swap: the connection now hears the mixer.
  const outgoingPlayer = session.player;
  session.connection.subscribe(mixPlayer);
  mixPlayer.play(mixResource);

  // Release the outgoing chain. Its PCM has no reader now, and an unread pipe
  // would back-pressure ffmpeg all the way to the tape. The tape already holds
  // more than the blend window needs.
  if (outgoingPlayer) {
    try { outgoingPlayer.stop(true); } catch { /* already gone */ }
  }
  session.outgoingPlayer = null;
  outgoingHandle.kill();

  session.player = mixPlayer;
  session.resource = mixResource;
  session.activeHandle = nextHandle;
  session.paused = false;
  session.deadStreamRestarts = 0;
  session.current = { ...nextVideo, progressSeconds: 0 };
  session.playedIds.add(nextVideo.videoId);
  // The incoming track has already advanced by the length of the blend.
  session.segmentStartOffset = fadeSec;
  session.segmentStartedAt = Date.now();

  attachPlayerEvents(session, mixPlayer, guild, channel);
  superviseStream(session, mixPlayer, nextHandle, nextVideo, guild, channel);

  // If the mixer never produces audio, fall back rather than wedge the radio.
  const watchdogStart = nextHandle.bytesProduced;
  session.crossfadeWatchdog = setTimeout(() => {
    session.crossfadeWatchdog = null;
    if (session.player !== mixPlayer) return;
    if (nextHandle.bytesProduced > watchdogStart) return;
    logger.warn(`[${session.guildId}] Crossfade produced no audio — reverting to a hard switch.`);
    session.crossfading = false;
    onTrackFinished(guild, channel);
  }, CROSSFADE_WATCHDOG_MS);

  mixer.once('end', () => {
    if (session.crossfadeWatchdog) {
      clearTimeout(session.crossfadeWatchdog);
      session.crossfadeWatchdog = null;
    }
  });

  await saveState(session);
  triggerUiUpdate(session).catch(() => {});
  playerEvents.emit('trackChange', { guildId: guild.id, video: session.current, paused: false });
  logger.info(`[${guild.id}] Crossfading into "${nextVideo.title}" over ${fadeSec}s`);

  // The swap has committed: the connection is on the mixer and the session
  // already describes the incoming track. The transition is no longer in
  // flight, so this flag has to come back down — otherwise `armCrossfade` bails
  // on its very first check forever, and the radio crossfades exactly once
  // and then hard-switches for the rest of the session.
  session.crossfading = false;

  // Arm the following crossfade now that we know this track's duration.
  // This only replaces timers — the tape belongs to the blend in progress and
  // is released by `onCrossfadeComplete`.
  armCrossfade(session, guild, channel, nextVideo, nextHandle);
  schedulePreload(session, nextVideo);
}

/**
 * Pick the track that follows the current one, using the preloaded track when
 * it matches. Returns null when playback should stop.
 */
async function selectNextVideo(session: any): Promise<any | null> {
  if (session.preloaded?.video) return session.preloaded.video;

  let catalog: any[];
  try {
    catalog = await getVideos();
  } catch (err: any) {
    logger.error(`[${session.guildId}] Could not load catalog for next track: ${err.message}`);
    return null;
  }

  syncQueueWithCatalog(session, catalog);
  const { videoId, newCycle } = popFromQueue(session, catalog);
  if (newCycle) {
    notify('🟢 دورة جديدة', NOTIFY.newCycle(session.cycleCount - 1, catalog.length), 'info').catch(() => {});
  }
  return catalog.find((v) => v.videoId === videoId) || null;
}

// ---------------------------------------------------------------------------
// Track transition
// ---------------------------------------------------------------------------

async function onTrackFinished(guild: any, channel: any): Promise<void> {
  const session = getSession(guild.id);
  if (session.advancing) return;
  session.advancing = true;

  try {
    // A live stream has no "next"; it only ends via a manual command.
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

    const outcome = await handleTrackOutcome(guild, channel, session);

    // A replay owns the transition: it re-enters *this* track, so advancing as
    // well would start a second, different track on top of it. The old code
    // cleared the `advancing` flag and fired the replay without awaiting, then
    // fell straight through to `advanceToNextTrack` — two AudioPlayers and two
    // process pairs competing for one voice slot.
    if (outcome === 'replay') {
      await replayCurrentTrack(guild, channel, session);
      return;
    }

    await advanceToNextTrack(guild, channel, session);
  } finally {
    session.advancing = false;
  }
}

type TrackOutcome = 'complete' | 'replay' | 'skip';

/**
 * Score how the finished track went and decide what happens next. Does not act
 * on it: the caller owns the transition, so a replay and an advance can never
 * both fire for one finished track.
 */
async function handleTrackOutcome(guild: any, channel: any, session: any): Promise<TrackOutcome> {
  if (!session.current?.videoId) return 'complete';
  if (session.segmentStartedAt == null) {
    await recordPlay(session.current, { completed: true }).catch(() => {});
    session.retryCount = 0;
    return 'complete';
  }

  const playedSeconds = (Date.now() - session.segmentStartedAt) / 1000;
  const expectedDuration = session.current?.durationSeconds || 0;
  const earlyEndPct = expectedDuration > 3600 ? 0.02 : expectedDuration > 600 ? 0.05 : 0.10;

  let outcome: TrackOutcome = 'complete';
  let earlyEnd = false;

  if (playedSeconds < 10) {
    session.retryCount = (session.retryCount || 0) + 1;
    if (session.retryCount <= MAX_TRACK_ATTEMPTS) {
      outcome = 'replay';
    } else {
      outcome = 'skip';
    }
  } else if (expectedDuration > 120 && playedSeconds < expectedDuration * earlyEndPct) {
    earlyEnd = true;
    session.earlyEndRetryCount = (session.earlyEndRetryCount || 0) + 1;
    outcome = session.earlyEndRetryCount <= MAX_TRACK_ATTEMPTS ? 'replay' : 'skip';
  }

  switch (outcome) {
    case 'replay':
      logger.warn(
        earlyEnd
          ? `[${guild.id}] Track ended early: ${Math.round(playedSeconds)}s/${expectedDuration}s (${pctOf(playedSeconds, expectedDuration)}%) — retrying (${session.earlyEndRetryCount}/${MAX_TRACK_ATTEMPTS})...`
          : `[${guild.id}] Track played only ${Math.round(playedSeconds)}s — retrying (${session.retryCount}/${MAX_TRACK_ATTEMPTS})...`,
      );
      return 'replay';

    case 'skip':
      logger.warn(`[${guild.id}] Track failed repeatedly — skipping.`);
      addFailedId(session, session.current.videoId);
      await recordPlay(session.current, { failed: true }).catch(() => {});
      session.retryCount = 0;
      session.earlyEndRetryCount = 0;
      await sleep(3000);
      return 'skip';

    default:
      await recordPlay(session.current, { completed: true }).catch(() => {});
      session.retryCount = 0;
      session.earlyEndRetryCount = 0;
      return 'complete';
  }
}

/**
 * Re-enter the track that just failed, from where it got to.
 *
 * Runs with `session.advancing` still set, so the restart cannot race the
 * normal advance. A failure here is handed back to `onTrackFinished` on the
 * next tick rather than recursed into, because the guard would swallow it.
 */
async function replayCurrentTrack(guild: any, channel: any, session: any): Promise<void> {
  if (session.segmentStartedAt != null) {
    await recordPlay(session.current, { failed: true }).catch(() => {});
    // `getElapsedSeconds` rather than a raw `Date.now()` diff, so the resume
    // point includes any earlier segment and is clamped to the track's real
    // duration — a resume past the end produces no audio at all.
    const reached = Math.floor(getElapsedSeconds(session));
    session.current = { ...session.current, progressSeconds: reached };
  }

  // The buffered next track belongs to a transition that is not happening.
  discardPreload(session);
  await sleep(2000);
  if (session.manualStop || !session.continuous) return;

  try {
    await connectAndPlay(guild, channel, session.current, { countPlay: false });
  } catch (err: any) {
    logger.warn(`[${guild.id}] Replay failed: ${err.message}`);
    setTimeout(() => { onTrackFinished(guild, channel).catch(() => {}); }, 0);
  }
}

function pctOf(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Walk forward to the next playable track.
 *
 * Each candidate gets a bounded number of attempts. This loop previously had no
 * such bound for a dead URL, and a separate "pre-validate" yt-dlp call was
 * spawned per track to try to detect that case up front.
 */
async function advanceToNextTrack(guild: any, channel: any, session: any): Promise<void> {
  let attempt = 0;
  let candidate: any = null;

  for (;;) {
    if (!session.continuous || session.manualStop) { discardPending(session); return; }

    if (!candidate) {
      if (!(await prepareNextTrack(session))) return;
      candidate = session.pendingVideo;
    }

    try {
      await playRandomJingle(guild, channel);
      session.current = candidate;
      session.playedIds.add(candidate.videoId);
      discardPreloadUnlessMatching(session, candidate);
      // Adopt the buffered stream when there is one. The previous code kept
      // only the preloaded *video* and dropped the handle, so the buffered
      // yt-dlp + ffmpeg pair was orphaned on every hard switch: ffmpeg blocked
      // on a full pipe, still tracked, never read and never closed.
      const buffered = takePendingHandle(session);
      await connectAndPlay(guild, channel, candidate, {
        countPlay: candidate.progressSeconds !== 0,
        handle: buffered ?? undefined,
      });
      return;
    } catch (err: any) {
      discardPending(session);
      attempt += 1;
      if (isNetworkError(err)) {
        logger.error(`[${guild.id}] Network error playing "${candidate?.title}" (attempt ${attempt}): ${err.message}`);
        await waitForNetwork(`[${guild.id}] network down`);
        attempt = 0;
        continue;
      }

      logger.error(`[${guild.id}] Failed to play "${candidate?.title}" (attempt ${attempt}): ${err.message}`);
      await recordPlay(candidate, { failed: true }).catch(() => {});

      if (attempt >= MAX_TRACK_ATTEMPTS) {
        logger.warn(`[${guild.id}] Giving up on "${candidate?.title}" after ${attempt} attempts.`);
        addFailedId(session, candidate.videoId);
        candidate = null;
        attempt = 0;
        continue;
      }
      await sleep(jitteredDelay(RETRY_BASE_DELAY_MS, attempt));
    }
  }
}

/** Pop the next candidate into `session.pendingVideo`, or return false to stop. */
async function prepareNextTrack(session: any): Promise<boolean> {
  // Any candidate left over from a previous round must be released first, or
  // its buffered stream outlives the track it was chosen for.
  discardPending(session);

  const preload = takePreload(session);
  if (preload) {
    session.pendingVideo = preload.video;
    session.pendingHandle = preload.handle;
    return true;
  }

  let catalog: any[];
  try {
    catalog = await getVideos();
  } catch (err: any) {
    logger.error(`[${session.guildId}] Could not load catalog: ${err.message}`);
    return false;
  }

  syncQueueWithCatalog(session, catalog);
  const { videoId, newCycle } = popFromQueue(session, catalog);
  if (newCycle) {
    notify('🟢 دورة جديدة', NOTIFY.newCycle(session.cycleCount - 1, catalog.length), 'info').catch(() => {});
  }
  const video = catalog.find((v) => v.videoId === videoId);
  if (!video) {
    logger.warn(`[${session.guildId}] No next video found, stopping.`);
    return false;
  }
  session.pendingVideo = video;
  return true;
}

/** Keep a preload only when it is the track we are about to play. */
function discardPreloadUnlessMatching(session: any, video: any): void {
  if (!session.preloaded) return;
  if (session.preloaded.video.videoId === video.videoId) return;
  discardPreload(session);
}

// ---------------------------------------------------------------------------
// Rejoin after disconnect
// ---------------------------------------------------------------------------

async function rejoinAndResume(guild: any, channel: any, attempt = 1): Promise<void> {
  const session = getSession(guild.id);
  if (!session.continuous || session.manualStop) return;

  try {
    // A channel object captured before the outage is not enough to judge
    // whether the guild is still there. `available === false` means Discord
    // told us the guild is unreachable, so a stale channel would join a
    // connection that can never become Ready and the ladder would run forever
    // against a bot that is no longer in the server. A plain REST failure
    // with the guild still available is just a blip, and the stale object is
    // the best we have.
    const freshChannel = await guild.channels.fetch(channel.id).catch(() => {
      if (!guild.available) return null;
      return channel;
    });
    if (!freshChannel || (freshChannel.isVoiceBased && !freshChannel.isVoiceBased())) {
      logger.warn(`[${session.guildId}] Voice channel is gone — stopping playback.`);
      notify('🔴 Voice Channel Unavailable', NOTIFY.rejoinFailed(guild.id, attempt, 'channel no longer exists'), 'warn').catch(() => {});
      discardPending(session);
      await stopPlayback(guild.id, { manual: false });
      return;
    }

    let video = session.current;
    let buffered: AudioStreamHandle | null = null;
    if (!video) {
      if (!(await prepareNextTrack(session))) return;
      video = session.pendingVideo;
      buffered = takePendingHandle(session);
    }

    try { await playRandomJingle(guild, freshChannel); } catch { /* jingle is optional */ }
    await connectAndPlay(guild, freshChannel, video, {
      countPlay: false,
      handle: buffered ?? undefined,
    });
    logger.info(`[${session.guildId}] Rejoined and resumed.`);
  } catch (err: any) {
    const networkError = isNetworkError(err);
    logger.error(`[${session.guildId}] Rejoin failed (attempt ${attempt}): ${err.message}`);
    logDashboardError(`[${session.guildId}] Rejoin failed (attempt ${attempt}): ${err.message}`);

    if (attempt === 5 || attempt % 50 === 0) {
      notify('🟡 Voice Rejoin Struggling', NOTIFY.rejoinFailed(guild.id, attempt, err.message), 'warn').catch(() => {});
    }

    if (attempt >= MAX_REJOIN_ATTEMPTS) {
      logger.error(`[${session.guildId}] Giving up after ${attempt} rejoin attempts — stopping.`);
      notify('🔴 Voice Rejoin Failed', NOTIFY.rejoinFailed(guild.id, attempt, err.message), 'error').catch(() => {});
      discardPending(session);
      await stopPlayback(guild.id, { manual: false });
      return;
    }

    if (networkError) {
      waitForNetwork(`[${session.guildId}] rejoin blocked on network`).then(() => {
        rejoinAndResume(guild, channel, attempt).catch(() => {});
      });
      return;
    }

    const delay = jitteredDelay(RETRY_BASE_DELAY_MS, attempt);
    session.rejoinTimer = setTimeout(() => {
      session.rejoinTimer = null;
      rejoinAndResume(guild, channel, attempt + 1).catch(() => {});
    }, delay);
  }
}

export { releaseSessionAudio, getActiveProcessCount };

/**
 * Internals exposed for tests.
 *
 * The crossfade transition is the riskiest part of the engine and cannot be
 * observed in a normal run (catalog tracks run for hours), so the timer and
 * swap logic is covered directly. Not part of the module's public API.
 */
export const __test = { armCrossfade, beginCrossfade, superviseStream, clearCrossfadeTimers };
