/**
 * discord-yt-audio-bot — main entry point.
 *
 * Plays YouTube audio in voice channels with continuous playback.
 * Commands: /كمل, /اخر_مقطع, /عشوائي
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, GatewayIntentBits, Events, Collection, ActivityType } from 'discord.js';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { notify } from './utils/webhook.js';
import { checkForYtdlpUpdate } from './utils/ytdlp-update.js';
import { startHeartbeat } from './utils/heartbeat.js';
import { startStatusPage } from './utils/status-page.js';
import { checkWeeklyRecap } from './utils/weekly-recap.js';
import {
  stopAllSessions,
  stopPlayback,
  playRandom,
  playLatest,
  playVideo,
  resume,
  playerEvents,
  getSessionInfo,
  getAllSessions,
  getQueue,
} from './services/player.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = createLogger('bot');
const soundsEnabled = (process.env.SOUND_EFFECTS_ENABLED || 'false') === 'true';

// Optional Sentry error tracking — SENTRY_DSN must be set in .env
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = await import('@sentry/node');
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();

const commandsDir = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsDir).filter((file) => file.endsWith('.js'));

for (const file of commandFiles) {
  const commandModule = await import(`./commands/${file}`);
  if (commandModule.data && commandModule.execute) {
    client.commands.set(commandModule.data.name, commandModule);
  } else {
    logger.warn(`Skipped ${file}: missing "data" or "execute" export.`);
  }
}

playerEvents.on('trackChange', ({ video, paused }) => {
  if (!client.user) return;
  if (!video) {
    client.user.setActivity(null);
    return;
  }
  client.user.setActivity(paused ? `⏸️ ${video.title}` : video.title, {
    type: ActivityType.Listening,
  });
});

client.once(Events.ClientReady, async (c) => {
  logger.info(`Logged in as ${c.user.tag}`);
  logger.info(`Channel ID: ${config.channelId}`);
  logger.info(`Commands loaded: /${[...client.commands.keys()].join(', /')}`);

  notify('🟢 Bot Started', `Logged in as **${c.user.tag}**.`, 'ok');
  startHeartbeat();

  // Dashboard command handler
  async function handleDashboardCommand(cmd) {
    const lower = cmd.toLowerCase().trim();
    if (lower === 'help') return 'Commands: status, np, random, resume, latest, play <videoId>';
    
    const all = getAllSessions();
    
    if (lower === 'status') {
      return 'Guilds: ' + all.length + ' | ' + all.map(s => s.guildName + ': ' + (s.connected ? 'Connected' : 'Idle')).join(', ');
    }
    if (lower === 'np' || lower === 'nowplaying') {
      return all.map(s => s.guildName + ': ' + (s.title || 'No track')).join('\n');
    }
    if (lower.startsWith('play ')) {
      const videoId = cmd.split(' ').slice(1).join(' ').trim();
      if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return 'Usage: play <videoId> (must be a valid 11-character YouTube ID)';
      }
      let done = 0;
      for (const s of all) {
        const guild = c.guilds.cache.get(s.guildId);
        if (guild && guild.members.me.voice.channel) {
          try {
            const { getVideoDetails } = await import('./services/youtube.js');
            const details = await getVideoDetails(videoId);
            const video = {
              videoId,
              title: details?.title || videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              thumbnail: details?.thumbnail || null,
              durationSeconds: details?.durationSeconds || null,
            };
            await playVideo(guild, guild.members.me.voice.channel, video);
            done++;
          } catch (err) {
            return `Error playing video: ${err.message}`;
          }
        }
      }
      return done > 0 ? `Playing on ${done} server(s).` : 'No active servers found.';
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
      let done = 0;
      for (const s of all) {
        const guild = c.guilds.cache.get(s.guildId);
        if (guild && guild.members.me.voice.channel) { await resume(guild, guild.members.me.voice.channel); done++; }
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
    return `Unknown command: "${cmd}". Type help for commands list.`;
  }

  startStatusPage(getSessionInfo, getAllSessions, handleDashboardCommand);

  // Weekly recap — check daily
  setInterval(checkWeeklyRecap, 60 * 60 * 1000);

  checkForYtdlpUpdate().catch((err) => logger.warn('yt-dlp update check failed:', err.message));
  setInterval(() => {
    checkForYtdlpUpdate().catch((err) => logger.warn('yt-dlp periodic update failed:', err.message));
  }, 1000 * 60 * 60 * 24); // Check daily

  for (const guild of c.guilds.cache.values()) {
    try {
      // Find the voice channel with the most humans across all channels in this guild
      const voiceChannels = guild.channels.cache.filter((ch) => ch.isVoiceBased());
      let targetChannel = null;
      let maxHumans = 0;

      for (const ch of voiceChannels.values()) {
        const humans = ch.members.filter((m) => !m.user.bot).size;
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
                const { playSoundEffect } = await import('./services/player.js');
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

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const guild = newState.guild;

    // Ignore all bot voice state changes
    if (newState.member?.user.bot) return;

    const session = getSessionInfo(guild.id);

    // --- User joined a channel ---
    const joinedChannel = newState.channel;
    if (joinedChannel && oldState.channelId !== newState.channelId) {
      const debounceKey = `join-${guild.id}`;
      const existing = voiceActionTimeouts.get(debounceKey);
      if (existing) clearTimeout(existing);
      voiceActionTimeouts.set(debounceKey, setTimeout(() => {
        voiceActionTimeouts.delete(debounceKey);
      }, VOICE_DEBOUNCE_MS));

      const humanCount = joinedChannel.members.filter((m) => !m.user.bot).size;
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
                const { playSoundEffect } = await import('./services/player.js');
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
          const currentHumans = botChannel.members.filter((m) => !m.user.bot).size;
          // Only move if joined channel now has strictly more humans
          if (humanCount > currentHumans) {
            const moveKey = `move-${guild.id}`;
            if (!voiceActionTimeouts.has(moveKey)) {
              voiceActionTimeouts.set(moveKey, setTimeout(async () => {
                voiceActionTimeouts.delete(moveKey);
                // Re-verify situation hasn't changed
                const freshJoined = guild.channels.cache.get(joinedChannel.id);
                if (!freshJoined) return;
                const freshHumans = freshJoined.members.filter((m) => !m.user.bot).size;
                const freshCurrent = guild.members.me?.voice?.channel?.members.filter((m) => !m.user.bot).size || 0;
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
    // If bot's channel is now empty of humans, wait — someone might come back
    if (oldState.channel && !newState.channel) {
      const botChannel = guild.members.me?.voice?.channel;
      if (botChannel && botChannel.id === oldState.channelId) {
        const remaining = botChannel.members.filter((m) => !m.user.bot).size;
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
      const payload = { content: `❌ حدث خطأ غير متوقع: ${err.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
    return;
  }
});

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down…`);
  stopAllSessions();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

function redactSecrets(str) {
  return String(str)
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot [REDACTED]')
    .replace(/[A-Za-z0-9._-]{20,}/g, '[REDACTED]');
}

process.on('unhandledRejection', (reason) => {
  // EPIPE errors from broken pipes are non-fatal — Discord voice sockets close abruptly
  if (reason?.code === 'EPIPE' || reason?.message?.includes('EPIPE')) return;
  if (reason?.message?.includes('Cannot perform IP discovery')) return;
  logger.error('Unhandled promise rejection:', redactSecrets(reason));
});

process.on('uncaughtException', (err) => {
  // EPIPE = broken pipe (e.g. ffmpeg/Discord UDP socket closed) — safe to ignore
  if (err?.code === 'EPIPE' || err?.message?.includes('EPIPE')) {
    logger.warn('Ignored EPIPE (broken pipe) error.');
    return;
  }
  // IP discovery failure on voice reconnect — recoverable, no restart needed
  if (err?.message?.includes('Cannot perform IP discovery')) {
    logger.warn('Ignored IP discovery error (voice reconnect in progress).');
    return;
  }
  logger.error('Uncaught exception — restarting:', redactSecrets(err?.stack || err));
  notify('🔴 Uncaught Exception — Restarting', `\`\`\`${redactSecrets(String(err?.stack || err)).slice(0, 1500)}\`\`\``, 'error').catch(() => {});
  stopAllSessions();
  setTimeout(() => process.exit(1), 500);
});

client.login(config.discordToken).catch(async (err) => {
  logger.error('Login failed:', err.message);
  await notify('🔴 Login Failed', `\`\`\`${err.message}\`\`\``, 'error');
  process.exit(1);
});
