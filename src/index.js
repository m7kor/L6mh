/**
 * discord-yt-audio-bot — main entry point.
 *
 * Plays YouTube audio in voice channels with continuous playback.
 * Commands: /كمل, /اخر_مقطع, /شيوائي
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, GatewayIntentBits, Events, Collection, ActivityType } from 'discord.js';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { notify } from './utils/webhook.js';
import { checkForYtdlpUpdate } from './utils/ytdlp-update.js';
import {
  stopAllSessions,
  playRandom,
  resume,
  playerEvents,
  getSessionInfo,
} from './services/player.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = createLogger('bot');

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
    type: ActivityType.Watching,
  });
});

client.once(Events.ClientReady, async (c) => {
  logger.info(`Logged in as ${c.user.tag}`);
  logger.info(`Channel ID: ${config.channelId}`);
  logger.info(`Commands loaded: /${[...client.commands.keys()].join(', /')}`);

  notify('🟢 Bot Started', `Logged in as **${c.user.tag}**.`, 'ok');

  checkForYtdlpUpdate().catch((err) => logger.warn('yt-dlp update check failed:', err.message));

  if (config.voiceChannelId) {
    for (const guild of c.guilds.cache.values()) {
      try {
        const channel = await guild.channels.fetch(config.voiceChannelId);
        if (channel && channel.isVoiceBased()) {
          logger.info(`[${guild.id}] Auto-joining #${channel.name}…`);

          try {
            const { resolveSoundPath, listSounds } = await import('./utils/sounds.js');
            const sounds = listSounds();
            if (sounds.length > 0) {
              const randomSound = sounds[Math.floor(Math.random() * sounds.length)];
              const soundPath = resolveSoundPath(randomSound);
              if (soundPath) {
                logger.info(`[${guild.id}] Playing startup sound: ${randomSound}`);
                const { playSoundEffect } = await import('./services/player.js');
                await playSoundEffect(guild, channel, soundPath);
                logger.info(`[${guild.id}] Startup sound finished.`);
              }
            }
          } catch (soundErr) {
            logger.warn(`[${guild.id}] Startup sound failed:`, soundErr.message);
          }

          try {
            await resume(guild, channel);
            logger.info(`[${guild.id}] Auto-resumed playback.`);
          } catch {
            logger.info(`[${guild.id}] No saved state — starting random playback.`);
            await playRandom(guild, channel);
          }
        } else {
          logger.warn(`[${guild.id}] Voice channel ${config.voiceChannelId} not found or not a voice channel.`);
        }
      } catch (err) {
        logger.error(`[${guild.id}] Failed to auto-join voice channel:`, err.message);
      }
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const guild = newState.guild;
    const session = getSessionInfo(guild.id);

    const joinedChannel = newState.channel;
    if (joinedChannel && oldState.channelId !== newState.channelId && !newState.member?.user.bot) {
      const humanCount = joinedChannel.members.filter((m) => !m.user.bot).size;
      const alreadyPlayingHere = session.connected && session.current;

      if (humanCount === 1 && !alreadyPlayingHere) {
        logger.info(`[${guild.id}] ${newState.member?.user.tag} joined #${joinedChannel.name} alone — auto-starting radio.`);
        try {
          const { resolveSoundPath, listSounds } = await import('./utils/sounds.js');
          const sounds = listSounds();
          if (sounds.length > 0) {
            const randomSound = sounds[Math.floor(Math.random() * sounds.length)];
            const soundPath = resolveSoundPath(randomSound);
            if (soundPath) {
              logger.info(`[${guild.id}] Playing join sound: ${randomSound}`);
              const { playSoundEffect } = await import('./services/player.js');
              await playSoundEffect(guild, joinedChannel, soundPath);
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
      }
      return;
    }

    const leftChannel = oldState.channel;
    if (leftChannel && oldState.channelId !== newState.channelId) {
      const botMember = await guild.members.fetchMe();
      const botIsThere = leftChannel.members.has(botMember.id);
      if (!botIsThere) return;

      const humansLeft = leftChannel.members.filter((m) => !m.user.bot).size;
      if (humansLeft === 0) {
        logger.info(`[${guild.id}] Everyone left #${leftChannel.name} — stopping and leaving.`);
        const { stopPlayback } = await import('./services/player.js');
        stopPlayback(guild.id, { manual: false });
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

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — restarting:', err);
  notify('🔴 Uncaught Exception — Restarting', `\`\`\`${String(err?.stack || err).slice(0, 1500)}\`\`\``, 'error');
  stopAllSessions();
  setTimeout(() => process.exit(1), 500);
});

client.login(config.discordToken).catch(async (err) => {
  logger.error('Login failed:', err.message);
  await notify('🔴 Login Failed', `\`\`\`${err.message}\`\`\``, 'error');
  process.exit(1);
});
