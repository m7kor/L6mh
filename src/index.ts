/**
 * discord-yt-audio-bot — main entry point.
 *
 * Plays YouTube audio in voice channels with continuous playback.
 * Commands: /كمل, /عشوائي
 */

import { Client, GatewayIntentBits, Events, Collection, ActivityType } from 'discord.js';
import type { ActivitiesOptions } from 'discord.js';
import { config } from './config.js';
import { loadCommandModules } from './utils/load-commands.js';
import { createLogger } from './utils/logger.js';
import { notify } from './utils/webhook.js';
import { checkForYtdlpUpdate } from './utils/ytdlp-update.js';
import { startHeartbeat, setProcessCounter, setHealthProbe } from './utils/heartbeat.js';
import { startStatusPage, broadcastTrackChange, setDiscordClient, logDashboardError } from './utils/status-page.js';
import { checkWeeklyRecap } from './utils/weekly-recap.js';
import { getProgrammingMode, MODE_LABELS } from './utils/programming-mode.js';
import { onVoiceJoin, onVoiceLeave, backfillUsernames, sweepPresence } from './services/community.js';
import { reapOrphanProcessesAndReport } from './services/streaming.js';
import { sweepJingleState } from './services/player/jingles.js';
import {
  stopAllSessions,
  stopPlayback,
  playRandom,
  playLatest,
  resume,
  connectAndPlay,
  playerEvents,
  getSessionInfo,
  getAllSessions,
  getQueue,
} from './services/player/index.js';
import { sessions, saveState, getSession } from './services/session.js';
import { releaseSessionAudio } from './services/player/engine.js';
import { forgetJingleState } from './services/player/jingles.js';
import { closeDb } from './utils/database.js';
import { migrateJsonToSqlite } from './utils/migration.js';
import { formatTime } from './utils/format.js';
import { isValidVideoId, forDisplay } from './utils/validators.js';

const logger = createLogger('bot');
const soundsEnabled = (process.env.SOUND_EFFECTS_ENABLED || 'false') === 'true';

/**
 * The bot's "listening to" presence. `timestamps` is only attached while
 * actually playing, so the shape is widened beyond the base activity type.
 */
type ClientActivity = ActivitiesOptions & { timestamps?: { start: Date } };

/**
 * Anything that could be a voice channel. Kept structural on purpose: discord.js
 * exposes `members` as a `Collection` for voice channels and a manager for stage
 * channels, and the union defeats `.filter()` typing. Both shapes expose `filter`.
 */
type VoiceChannelLike = {
  id?: string;
  name?: string;
  members?: { filter(fn: (m: any) => boolean): { size: number } };
};

/** Count non-bot members in a voice channel, tolerating both member container types. */
function countHumans(channel: unknown): number {
  const members = (channel as VoiceChannelLike | null | undefined)?.members;
  if (!members || typeof members.filter !== 'function') return 0;
  return members.filter((m: any) => !m.user?.bot).size;
}

// Optional Sentry error tracking — SENTRY_DSN must be set in .env, and the
// SDK is an optional dependency, so the import is resolved at runtime.
if (process.env.SENTRY_DSN) {
  try {
    const sentryModule = '@sentry/node';
    const Sentry = await import(sentryModule);
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
    logger.info('Sentry error tracking enabled.');
  } catch {
    logger.warn('Sentry SDK not installed — error tracking disabled.');
  }
}

// ---------------------------------------------------------------------------
// Anti-flap hysteresis — debounce voice state changes per guild
// ---------------------------------------------------------------------------

const voiceActionTimeouts = new Map();
const VOICE_DEBOUNCE_MS = 4_000;

/**
 * Run the username backfill at most once at a time.
 *
 * The backoff loop used to `Promise.race` a 30s timeout against a task that
 * fetches one Discord user per row. Losing the race does not cancel it, so the
 * work kept running for minutes after the boot moved on — and the dashboard's
 * `POST /api/backfill-usernames` could start a second one on top, doubling the
 * REST traffic.
 */
let backfillInFlight: Promise<number> | null = null;
function backfillOnce(c: any): Promise<number> {
  if (backfillInFlight) return backfillInFlight;
  backfillInFlight = backfillUsernames(c)
    .catch(() => 0)
    .finally(() => { backfillInFlight = null; });
  return backfillInFlight;
}

/**
 * Stop everything for a guild and drop its session.
 *
 * Stopping alone is not enough: the session would keep its queue, its playedIds
 * and its voice connection, and the housekeeping sweep only reclaims sessions
 * that never had a connection. A guild the bot is no longer in will never be
 * reclaimed by that path.
 */
async function releaseGuildSession(guildId: string): Promise<void> {
  const session = sessions.get(guildId);
  if (session) releaseSessionAudio(session);
  await stopPlayback(guildId, { manual: true }).catch((err) => {
    logger.debug(`[${guildId}] Stop during release failed: ${err.message}`);
  });
  sessions.delete(guildId);
  forgetJingleState(guildId);
  logDashboardError(`[${guildId}] Bot was removed from this guild; session released.`, 'warn');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();

for (const { module } of await loadCommandModules((msg) => logger.warn(msg))) {
  client.commands.set(module.data.name, module);
}

if (client.commands.size === 0) {
  logger.error('No slash commands loaded — /help-style commands will be unavailable.');
}

playerEvents.on('trackChange', ({ guildId, video, paused }) => {
  if (!client.user) return;
  if (!video) {
    client.user.setPresence({ activities: [], status: 'online' });
    broadcastTrackChange();
    return;
  }

  const session = sessions.get(guildId);
  const channelName = session?.channel?.name || '—';
  const elapsed = session?.segmentStartedAt
    ? Math.floor((Date.now() - session.segmentStartedAt) / 1000)
    : 0;

  const mode = getProgrammingMode();
  const modeLabel = MODE_LABELS[mode];

  // Discord renders only `name` and `state` for a Listening activity — a
  // `details` field here was accepted by the API but never displayed, so the
  // progress line was invisible. Everything goes into `state`.
  const activity: ClientActivity = {
    name: `🎙️ راديو وحيد عمر — ${video.title || '—'}`,
    type: ActivityType.Listening,
    state: paused
      ? `⏸️ ${modeLabel} — متوقف مؤقتاً • #${channelName}`
      : `${modeLabel} • #${channelName} • ▶️ ${formatTime(elapsed)}${video.durationSeconds ? ' / ' + formatTime(video.durationSeconds) : ''}`,
  };

  if (!paused && session?.segmentStartedAt) {
    activity.timestamps = { start: new Date(session.segmentStartedAt) };
  }

  client.user.setPresence({ activities: [activity], status: paused ? 'idle' : 'online' });
  broadcastTrackChange();
});

client.once(Events.ClientReady, async (c) => {
  // Every subsystem below is started independently.
  //
  // This handler used to be one long unguarded `async` function, so a single
  // rejection — a database that would not open, a migration that threw — took
  // the rest of it with it. The rejection was then swallowed by the
  // unhandledRejection handler, and the result was a bot that reported itself
  // online with no heartbeat, no scheduler, no dashboard and no auto-join, and
  // nothing anywhere reporting why.
  const bootStep = async (name: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err: any) {
      logger.error(`Startup step "${name}" failed: ${err.message}`);
      logDashboardError(`Startup step "${name}" failed: ${err.message}`);
    }
  };

  logger.info(`Logged in as ${c.user.tag}`);
  logger.info(`Channel ID: ${config.channelId}`);
  logger.info(`Commands loaded: /${[...client.commands.keys()].join(', /')}`);

  await bootStep('migrate-json', () => migrateJsonToSqlite());

  const guildCount = c.guilds.cache.size;
  await bootStep('notify-started', () => notify(
    '🟢 Bot Started',
    `Logged in as **${c.user.tag}**\nServers: ${guildCount}\nCommands: /${[...client.commands.keys()].join(', /')}`,
    'ok',
  ));

  await bootStep('process-counter', async () => {
    const { getActiveProcessCount, getOrphanProcessCount } = await import('./services/streaming.js');
    setProcessCounter(getActiveProcessCount);
    setHealthProbe(() => ({
      // A count well above 2-4 is the signature of a preloaded stream that was
      // abandoned without being killed: ffmpeg blocked on a full pipe, still
      // in the process table, never read and never closed.
      processes: getActiveProcessCount(),
      orphans: getOrphanProcessCount(),
      gatewayPing: c.ws?.ping ?? null,
      ready: c.isReady(),
      sessions: sessions.size,
    }));
    startHeartbeat();
  });

  // Backfill usernames in the background. The race bounds how long the boot
  // waits, but it cannot cancel the loser, so the work itself is guarded
  // against running twice concurrently.
  backfillOnce(c)
    .then(total => { if (total > 0) logger.info(`Backfilled ${total} usernames`); })
    .catch(() => {});

  await bootStep('scheduler', async () => {
    const { startScheduler } = await import('./services/scheduler.js');
    startScheduler(c);
  });

  // Dashboard command handler
  async function handleDashboardCommand(cmd, targetGuildId = null) {
    const lower = cmd.toLowerCase().trim();
    if (lower === 'help') return 'Commands: status, np, random, resume, latest, stop, skip, volume <0-100>, play <videoId>, search <query>';
    
    let all = getAllSessions();
    // Guild-scoped: if targetGuildId provided, only operate on that guild
    if (targetGuildId) {
      all = all.filter(s => s.guildId === targetGuildId);
      if (all.length === 0) return 'Guild not found or not connected.';
    }
    
    if (lower === 'status') {
      return 'Guilds: ' + all.length + ' | ' + all.map(s => s.guildName + ': ' + (s.connected ? 'Connected' : 'Idle')).join(', ');
    }
    if (lower === 'np' || lower === 'nowplaying') {
      return all.map(s => s.guildName + ': ' + (s.title || 'No track')).join('\n');
    }
    if (lower === '/عشوائي' || lower === 'random') {
      let done = 0;
      for (const s of all) {
        const guild = c.guilds.cache.get(s.guildId);
        if (guild && guild.members.me.voice.channel) { await playRandom(guild, guild.members.me.voice.channel); done++; }
      }
      return done > 0 ? `Playing random on ${done} server(s).` : 'No active servers found.';
    }
    if (lower === '/كمل' || lower === 'resume') {
      const { resumePlayback } = await import('./services/player/controls.js');
      let done = 0;
      for (const s of all) {
        if (s.paused) {
          try { await resumePlayback(s.guildId); done++; } catch (e) { logger.debug(`resume ${s.guildId} failed: ${e.message}`); }
        } else {
          const guild = c.guilds.cache.get(s.guildId);
          if (guild && guild.members.me?.voice?.channel) { await resume(guild, guild.members.me.voice.channel); done++; }
        }
      }
      return done > 0 ? `Resumed on ${done} server(s).` : 'No active servers found.';
    }
    if (lower === '/اخر_مقطع' || lower === 'latest') {
      let done = 0;
      for (const s of all) {
        const guild = c.guilds.cache.get(s.guildId);
        if (guild && guild.members.me.voice.channel) { await playLatest(guild, guild.members.me.voice.channel); done++; }
      }
      return done > 0 ? `Playing latest on ${done} server(s).` : 'No active servers found.';
    }
    if (lower === 'pause') {
      const { pausePlayback } = await import('./services/player/controls.js');
      let done = 0;
      for (const s of all) {
        try { await pausePlayback(s.guildId); done++; } catch (e) { logger.debug(`pause ${s.guildId} failed: ${e.message}`); }
      }
      return done > 0 ? `Paused on ${done} server(s).` : 'No active servers found.';
    }
    if (lower === '/ايقاف' || lower === 'stop') {
      let done = 0;
      for (const s of all) {
        try { await stopPlayback(s.guildId, { manual: true }); done++; } catch (e) { logger.debug(`stop ${s.guildId} failed: ${e.message}`); }
      }
      return done > 0 ? `Stopped on ${done} server(s).` : 'No active servers found.';
    }
    if (lower === 'skip') {
      const { skipTrack } = await import('./services/player/controls.js');
      let done = 0;
      for (const s of all) {
        try { skipTrack(s.guildId); done++; } catch (e) { logger.debug(`skip ${s.guildId} failed: ${e.message}`); }
      }
      return done > 0 ? `Skipped on ${done} server(s).` : 'No active servers found.';
    }
    if (lower.startsWith('volume ')) {
      const val = parseInt(lower.slice(7));
      if (isNaN(val) || val < 0 || val > 100) return 'Invalid volume. Use 0-100.';
      const { setVolume } = await import('./services/player/controls.js');
      let done = 0;
      for (const s of all) {
        // Awaited: this restarts the track, so a floating call reported
        // success for a volume change that may not have been applied.
        try { await setVolume(s.guildId, val, connectAndPlay); done++; } catch (e) { logger.debug(`volume ${s.guildId} failed: ${e.message}`); }
      }
      return done > 0 ? `Volume set to ${val}% on ${done} server(s).` : 'No active servers found.';
    }
    if (lower.startsWith('qrm ')) {
      const index = parseInt(lower.slice(4).trim());
      if (isNaN(index)) return 'Invalid index';
      const { removeFromQueue } = await import('./services/player/controls.js');
      let done = 0;
      for (const s of all) {
        if (await removeFromQueue(s.guildId, index)) done++;
      }
      return done > 0 ? 'Removed from queue' : 'Not found in queue';
    }
    if (lower.startsWith('qtop ')) {
      const index = parseInt(lower.slice(5).trim());
      if (isNaN(index)) return 'Invalid index';
      const { moveToTopQueue } = await import('./services/player/controls.js');
      let done = 0;
      for (const s of all) {
        if (await moveToTopQueue(s.guildId, index)) done++;
      }
      return done > 0 ? 'Moved to top of queue' : 'Not found in queue';
    }
    if (lower.startsWith('play ')) {
      const videoId = cmd.slice(5).trim();
      if (!isValidVideoId(videoId)) {
        return 'Invalid video ID format.';
      }
      const { getVideos } = await import('./services/youtube.js');
      const { playVideo } = await import('./services/player/index.js');
      const catalog = await getVideos();
      const video = catalog.find(v => v.videoId === videoId);
      if (!video) return 'Video not found in catalog.';
      let done = 0;
      for (const s of all) {
        const guild = c.guilds.cache.get(s.guildId);
        if (guild && guild.members.me.voice.channel) {
          await playVideo(guild, guild.members.me.voice.channel, video);
          done++;
        }
      }
      return done > 0 ? `Playing "${video.title}" on ${done} server(s).` : 'No active servers found.';
    }
    if (lower.startsWith('search ')) {
      const query = cmd.slice(7).trim();
      if (!query) return 'Provide a search query.';
      const { getVideos } = await import('./services/youtube.js');
      const catalog = await getVideos();
      const matches = catalog.filter(v => (v.title || '').toLowerCase().includes(query.toLowerCase())).slice(0, 10);
      if (matches.length === 0) return `No results for "${forDisplay(query, 40)}".`;
      return matches.map((v, i) => `${i + 1}. ${v.title} (${v.videoId})`).join('\n');
    }
    if (lower.startsWith('sleeptimer ')) {
      const mins = parseInt(lower.slice(11));
      if (isNaN(mins) || mins < 0 || mins > 480) return 'Invalid minutes. Use 0-480.';
      const { setTimer, cancelTimer } = await import('./commands/sleeptimer.js');
      if (mins === 0) {
        for (const s of all) cancelTimer(s.guildId);
        return 'Sleep timer cancelled.';
      }
      for (const s of all) setTimer(s.guildId, mins);
      return `Sleep timer set: ${mins} minutes.`;
    }
    // The raw command is not echoed back. These replies are JSON today, so it
    // is not exploitable — but the dashboard renders `reply` into the DOM, and
    // reflecting unvalidated input into a message body is a primitive that only
    // needs one careless future renderer to become stored XSS. Truncate as
    // well: an unbounded echo has no use in an error message.
    return `Unknown command: "${forDisplay(cmd, 40)}". Type help for commands list.`;
  }

  setDiscordClient(c);
  await bootStep('status-page', () => startStatusPage(getSessionInfo, getAllSessions, handleDashboardCommand, getQueue));

  // Weekly recap — check daily. Wrapped because an unhandled rejection from a
  // timer callback is invisible: nothing ever sees the error and the interval
  // keeps running, so the failure looks like the recap simply never fires.
  setInterval(() => {
    checkWeeklyRecap().catch((err) => logger.error('Weekly recap failed:', err.message));
  }, 60 * 60 * 1000);

  checkForYtdlpUpdate().catch((err) => logger.warn('yt-dlp update check failed:', err.message));
  setInterval(() => {
    checkForYtdlpUpdate().catch((err) => logger.warn('yt-dlp periodic update failed:', err.message));
  }, 1000 * 60 * 60 * 24); // Check daily

  // Periodic state backup — save all sessions every 60s
  setInterval(() => {
    for (const [guildId] of sessions) {
      try { saveState(getSession(guildId)); } catch (err: any) { logger.debug(`State save failed for ${guildId}: ${err.message}`); }
    }
  }, 60_000);

  // Session cleanup — reclaim sessions that are holding nothing
  setInterval(() => {
    const now = Date.now();
    for (const [guildId, session] of sessions) {
      if (session.connection || session.player || session.activeHandle) continue;
      // A session that is mid-`connectAndPlay` also has no player yet, since
      // the teardown runs before the stream is spawned. The in-flight flags are
      // what distinguish "waiting on yt-dlp" from "finished and idle".
      if (session.advancing || session.recovering || session.rejoinTimer) continue;
      // A manually stopped session used to be exempt from this sweep entirely,
      // so any guild the bot had ever played in kept its queue, its playedIds
      // and its Discord object references for the life of the process. A stop
      // already empties the queue, so there is nothing left to preserve.
      const lastActivity = session.segmentStartedAt || session.cycleStartedAt;
      const idleFor = lastActivity ? now - new Date(lastActivity).getTime() : Infinity;
      if (idleFor > 3600_000) {
        sessions.delete(guildId);
        forgetJingleState(guildId);
        logger.info(`[${guildId}] Cleaned up idle session.`);
      }
    }
  }, 300_000);

  // Housekeeping — reap orphaned child processes and bound the per-guild maps
  // that are only ever written to.
  setInterval(() => {
    void reapOrphanProcessesAndReport();
    sweepPresence();
    sweepJingleState(new Set(sessions.keys()));
  }, 300_000);

  for (const guild of c.guilds.cache.values()) {
    try {
      // Find the voice channel with the most humans across all channels in this guild
      const voiceChannels = guild.channels.cache.filter((ch) => ch.isVoiceBased());
      let targetChannel = null;
      let maxHumans = 0;

      for (const ch of voiceChannels.values()) {
        const humans = countHumans(ch);
        if (humans > maxHumans) {
          maxHumans = humans;
          targetChannel = ch;
        }
      }

      if (targetChannel && maxHumans > 0) {
        logger.info(`[${guild.id}] Auto-joining #${targetChannel.name} (${maxHumans} humans)…`);

        try {
          if (soundsEnabled) {
            const { resolveSoundPath, listSounds } = await import('./utils/sounds.js');
            const sounds = listSounds();
            if (sounds.length > 0) {
              const randomSound = sounds[Math.floor(Math.random() * sounds.length)];
              const soundPath = resolveSoundPath(randomSound);
              if (soundPath) {
                logger.info(`[${guild.id}] Playing startup sound: ${randomSound}`);
                const { playSoundEffect } = await import('./services/player/index.js');
                await playSoundEffect(guild, targetChannel, soundPath);
                logger.info(`[${guild.id}] Startup sound finished.`);
              }
            }
          }
        } catch (soundErr) {
          logger.warn(`[${guild.id}] Startup sound failed:`, soundErr.message);
        }

        try {
          await resume(guild, targetChannel);
          logger.info(`[${guild.id}] Auto-resumed playback.`);
          // Restore sleep timer if one was active before restart
          try {
            const { restoreTimer } = await import('./commands/sleeptimer.js');
            const session = getSession(guild.id);
            if (session?.sleepDeadline) restoreTimer(guild.id, session.sleepDeadline);
          } catch {}
        } catch {
          logger.info(`[${guild.id}] No saved state — starting random playback.`);
          await playRandom(guild, targetChannel);
        }
      } else {
        logger.info(`[${guild.id}] No voice channel with humans found — waiting for someone to join.`);
      }
    } catch (err) {
      logger.error(`[${guild.id}] Failed to auto-join voice channel:`, err.message);
    }
  }
});

client.on(Events.GuildDelete, (guild) => {
  // The bot was removed. Nothing else notices: the rejoin ladder keeps
  // retrying a channel it can no longer reach, burning a 60s timeout each
  // cycle, while the session keeps its queue, its playedIds and its connection
  // object in memory forever.
  logger.warn(`[${guild.id}] Removed from guild — releasing session.`);
  releaseGuildSession(guild.id);
  for (const [key, timeout] of voiceActionTimeouts) {
    if (key.endsWith(guild.id)) {
      clearTimeout(timeout);
      voiceActionTimeouts.delete(key);
    }
  }
});

client.on(Events.Error, (err) => {
  logger.error('Discord client error:', redactSecrets(err?.stack || String(err)));
  logDashboardError(`Discord client error: ${err?.message}`);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const guild = newState.guild;

    // Ignore all bot voice state changes
    if (newState.member?.user.bot) return;

    const session = getSessionInfo(guild.id);

    // --- User joined a channel ---
    const joinedChannel = newState.channel;
    if (joinedChannel && oldState.channelId !== newState.channelId) {
      // Track community presence
      const avatarUrl = newState.member?.user?.displayAvatarURL({ size: 64, extension: 'png' }) || null;
      onVoiceJoin(newState.member?.user?.id, guild.id, newState.member?.user?.username || newState.member?.displayName, avatarUrl);

      const debounceKey = `join-${guild.id}`;
      const existing = voiceActionTimeouts.get(debounceKey);
      if (existing) clearTimeout(existing);
      voiceActionTimeouts.set(debounceKey, setTimeout(() => {
        voiceActionTimeouts.delete(debounceKey);
      }, VOICE_DEBOUNCE_MS));

      const humanCount = countHumans(joinedChannel);
      const isBotIdle = !session.connected;

      // Bot was idle → start playing in the newly joined channel
      if (humanCount >= 1 && isBotIdle) {
        logger.info(`[${guild.id}] ${newState.member?.user.tag} joined #${joinedChannel.name} — auto-starting radio.`);
        try {
          if (soundsEnabled) {
            const { resolveSoundPath, listSounds } = await import('./utils/sounds.js');
            const sounds = listSounds();
            if (sounds.length > 0) {
              const randomSound = sounds[Math.floor(Math.random() * sounds.length)];
              const soundPath = resolveSoundPath(randomSound);
              if (soundPath) {
                const { playSoundEffect } = await import('./services/player/index.js');
                await playSoundEffect(guild, joinedChannel, soundPath);
              }
            }
          }
        } catch (soundErr) {
          logger.warn(`[${guild.id}] Join sound failed:`, soundErr.message);
        }
        try {
          await resume(guild, joinedChannel);
        } catch {
          await playRandom(guild, joinedChannel);
        }
        return;
      }

      // Bot is active → check if the new channel has MORE humans and auto-move
      if (session.connected && humanCount >= 1) {
        const botChannel = guild.members.me?.voice?.channel;
        if (botChannel && botChannel.id !== joinedChannel.id) {
          const currentHumans = countHumans(botChannel);
          // Only move if joined channel now has strictly more humans
          if (humanCount > currentHumans) {
            const moveKey = `move-${guild.id}`;
            if (!voiceActionTimeouts.has(moveKey)) {
              voiceActionTimeouts.set(moveKey, setTimeout(async () => {
                voiceActionTimeouts.delete(moveKey);
                // Re-verify situation hasn't changed
                const freshJoined = guild.channels.cache.get(joinedChannel.id);
                if (!freshJoined) return;
                const freshHumans = countHumans(freshJoined);
                const freshCurrent = countHumans(guild.members.me?.voice?.channel);
                if (freshHumans > freshCurrent) {
                  logger.info(`[${guild.id}] Auto-moving to #${joinedChannel.name} (${freshHumans} humans vs ${freshCurrent}).`);
                  try {
                    await resume(guild, freshJoined);
                  } catch {
                    await playRandom(guild, freshJoined);
                  }
                }
              }, VOICE_DEBOUNCE_MS));
            }
          }
        }
      }
      return;
    }

    // --- User left a channel (oldState has channel, newState doesn't) ---
    // Track community presence
    if (oldState.channel && oldState.member?.user?.id) {
      onVoiceLeave(oldState.member.user.id, guild.id);
    }

    // If bot's channel is now empty of humans, wait — someone might come back
    if (oldState.channel && !newState.channel) {
      const botChannel = guild.members.me?.voice?.channel;
      if (botChannel && botChannel.id === oldState.channelId) {
        const remaining = countHumans(botChannel);
        if (remaining === 0) {
          logger.info(`[${guild.id}] Channel #${botChannel.name} is now empty. Bot stays but will auto-move when someone joins.`);
        }
      }
    }
  } catch (err) {
    logger.error('VoiceStateUpdate handler error:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error(`Error executing /${interaction.commandName}:`, err);
      const payload = { content: '❌ حدث خطأ غير متوقع. تم تسجيل التفاصيل.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton()) {
    // Only allow administrators to use control panel buttons
    if (!interaction.memberPermissions?.has('Administrator')) {
      return interaction.reply({ content: '❌ هذه الأزرار مخصصة للإدارة فقط.', ephemeral: true });
    }

    const { skipTrack, pausePlayback, resumePlayback, getSessionInfo } = await import('./services/player/index.js');
    const guildId = interaction.guildId;
    const botChannel = interaction.guild.members.me?.voice?.channel;

    if (!botChannel) {
      return interaction.reply({ content: '❌ البوت غير متصل بأي روم صوتي.', ephemeral: true });
    }

    try {
      if (interaction.customId === 'radio_toggle_pause') {
        const session = getSessionInfo(guildId);
        if (session.paused) {
          await resumePlayback(guildId);
          await interaction.reply({ content: '▶️ تم استكمال التشغيل.', ephemeral: true });
        } else {
          await pausePlayback(guildId);
          await interaction.reply({ content: '⏸️ تم إيقاف التشغيل مؤقتاً.', ephemeral: true });
        }
      } else if (interaction.customId === 'radio_skip') {
        skipTrack(guildId);
        await interaction.reply({ content: '⏭️ تم التخطي بنجاح.', ephemeral: true });
      } else if (interaction.customId === 'radio_random') {
        await playRandom(interaction.guild, botChannel);
        await interaction.reply({ content: '🔀 جاري تشغيل مقطع عشوائي...', ephemeral: true });
      }
    } catch (err) {
      logger.error('Button interaction error:', err);
      await interaction.reply({ content: '❌ حدث خطأ أثناء تنفيذ الأمر.', ephemeral: true });
    }
  }
});

function redactSecrets(str) {
  return String(str)
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot [REDACTED]')
    .replace(/[A-Za-z0-9._-]{20,}/g, '[REDACTED]');
}

/** The shape of the values Node hands to the process-level error handlers. */
interface ErrorLike {
  code?: string;
  message?: string;
  stack?: string;
}

/**
 * Transient failures that discord.js and the voice layer recover from on their
 * own. Restarting on these would turn a momentary network blip into downtime.
 */
const TRANSIENT_CODES = new Set([
  'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET',
  'ECONNREFUSED', 'ECONNABORTED', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED',
]);

function isTransient(err: unknown): boolean {
  const e = err as ErrorLike | null | undefined;
  if (!e) return false;
  if (e.code && TRANSIENT_CODES.has(e.code)) return true;
  const message = e.message || '';
  return /EPIPE|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_SOCKET_CLOSED|Cannot perform IP discovery|Opening handshake/i.test(message);
}

process.on('unhandledRejection', (reason) => {
  if (isTransient(reason)) return;
  logger.error('Unhandled promise rejection:', redactSecrets(reason));
  logDashboardError(`Unhandled rejection: ${String((reason as ErrorLike)?.message ?? reason).slice(0, 300)}`);
});

/**
 * Flush state, then let the supervisor restart us.
 *
 * The old version called `stopAllSessions()` without awaiting it and exited
 * 500ms later, so a crash could land mid-write on the SQLite state — which is
 * exactly the moment losing the queue hurts most. The recorded crashes here
 * are all network handshakes, so this path is not theoretical.
 */
process.on('uncaughtException', (err: Error) => {
  if (isTransient(err)) {
    logger.warn(`Ignored transient error (${(err as ErrorLike).code || 'no-code'}): ${err.message}`);
    return;
  }
  logger.error('Uncaught exception — restarting:', redactSecrets(err?.stack || err));
  logDashboardError(`Uncaught exception: ${err?.message}`);
  notify('🔴 Uncaught Exception — Restarting', `\`\`\`${redactSecrets(String(err?.stack || err)).slice(0, 1500)}\`\`\``, 'error').catch(() => {});

  const hardExit = setTimeout(() => {
    logger.error('State flush did not finish in time — exiting anyway.');
    process.exit(1);
  }, 8_000);
  hardExit.unref?.();

  stopAllSessions()
    .catch((flushErr) => logger.error('State flush failed:', flushErr?.message))
    .finally(() => {
      clearTimeout(hardExit);
      try { closeDb(); } catch { /* already closed */ }
      process.exit(1);
    });
});

function gracefulShutdown(signal) {
  logger.info(`Received ${signal} — saving state and shutting down...`);
  for (const [, timeout] of voiceActionTimeouts) clearTimeout(timeout);
  voiceActionTimeouts.clear();
  const tasks = [];
  for (const [guildId] of sessions) {
    tasks.push(stopPlayback(guildId, { manual: false }));
  }

  const shutdownTimeout = setTimeout(() => {
    logger.warn('Shutdown timeout — forcing exit.');
    process.exit(1);
  }, 10_000);

  Promise.all(tasks)
    .then(() => {
      logger.info('All sessions saved. Closing database...');
      closeDb();
      logger.info('Destroying Discord client...');
      return client.destroy();
    })
    .catch((err) => {
      logger.error('Error during shutdown:', err.message);
      closeDb();
      try { client.destroy(); } catch {}
    })
    .finally(() => {
      clearTimeout(shutdownTimeout);
      logger.info('Shutdown complete.');
      process.exit(0);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));

/**
 * Log in.
 *
 * `config.discordToken` is read *inside* this async function, not as an
 * argument. Passing it as an argument would evaluate the lazy config proxy
 * before the promise existed, so a missing `.env` produced a raw stack trace
 * with no explanation and no webhook. The notification is guarded too: the
 * error path used to read `config.healthWebhookUrl` from the same throwing
 * proxy, turning a clear config error into an unhandled rejection.
 */
async function login(): Promise<void> {
  const token = config.discordToken;
  await client.login(token);
}

login().catch(async (err) => {
  logger.error('Login failed:', redactSecrets(err?.message || String(err)));
  logDashboardError(`Login failed: ${err?.message || String(err)}`);
  try {
    await notify('🔴 Login Failed', `\`\`\`${redactSecrets(String(err?.message || err)).slice(0, 500)}\`\`\``, 'error');
  } catch { /* webhook is best-effort */ }
  process.exit(1);
});
