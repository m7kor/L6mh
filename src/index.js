/**
 * discord-yt-audio-bot — main entry point.
 *
 * A bot that plays YouTube audio in voice channels, with continuous
 * ("random") playback, a preview queue, skip, volume control, a local
 * soundboard, and per-guild session state.
 *
 * Slash commands (see src/commands/ for each one):
 *   /watch                 — play the channel's latest video, then continue forever (24/7)
 *   /watch mode:random     — start with a random pick instead, then continue forever
 *   /nowplaying            — show the live now-playing card again
 *   /skip                  — skip the current track
 *   /queue                 — show the current + upcoming tracks
 *   /volume percent:<n>    — set playback volume (0-200%)
 *   /sound name:<name>     — play a short local sound effect
 *   /status                — bot diagnostics
 *   /كمل                   — resume the last video
 *
 * Every play command runs 24/7 — once a video ends, the next one (random)
 * starts automatically. There's no /stop command by design (see README);
 * use the ⏹️ button on the Now Playing card for a manual override.
 *
 * Also auto-joins whenever someone enters an empty voice channel alone
 * (see the VoiceStateUpdate handler below), on top of the static
 * VOICE_CHANNEL_ID auto-join at startup.
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
  skip,
  stopPlayback,
  togglePause,
  nudgeVolume,
  playRandom,
  resume,
  playSoundEffect,
  playerEvents,
  getSessionInfo,
} from './services/player.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = createLogger('bot');

// ---------------------------------------------------------------------------
// Load commands
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Live bot presence — "Watching <title>" while something is playing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ready event
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, async (c) => {
  logger.info(`Logged in as ${c.user.tag}`);
  logger.info(`Channel ID: ${config.channelId}`);
  logger.info(`Commands loaded: /${[...client.commands.keys()].join(', /')}`);

  notify('🟢 Bot Started', `Logged in as **${c.user.tag}**.`, 'ok');

  // Best-effort, non-blocking: yt-dlp lags behind YouTube's site changes
  // often enough that a stale copy is a common cause of "audio just stopped
  // working." Check once at startup and self-update if possible.
  checkForYtdlpUpdate().catch((err) => logger.warn('yt-dlp update check failed:', err.message));

  // Auto-join voice channel and start random playback if configured.
  // Runs for every guild the bot is in (not just the first one), so it
  // behaves correctly if the bot ever gets added to more than one server.
  if (config.voiceChannelId) {
    for (const guild of c.guilds.cache.values()) {
      try {
        const channel = await guild.channels.fetch(config.voiceChannelId);
        if (channel && channel.isVoiceBased()) {
          logger.info(`[${guild.id}] Auto-joining #${channel.name}…`);

          // Play a random notification sound first, then resume the last video
          try {
            const { resolveSoundPath, listSounds } = await import('./utils/sounds.js');
            const sounds = listSounds();
            if (sounds.length > 0) {
              const randomSound = sounds[Math.floor(Math.random() * sounds.length)];
              const soundPath = resolveSoundPath(randomSound);
              if (soundPath) {
                logger.info(`[${guild.id}] Playing startup sound: ${randomSound}`);
                await playSoundEffect(guild, channel, soundPath);
                logger.info(`[${guild.id}] Startup sound finished.`);
              }
            }
          } catch (soundErr) {
            logger.warn(`[${guild.id}] Startup sound failed:`, soundErr.message);
          }

          // Try to resume the last video; fall back to random if no saved state
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

// ---------------------------------------------------------------------------
// Auto-join when someone enters an empty voice channel alone
// ---------------------------------------------------------------------------
// If the bot isn't already playing in this guild, and a human joins a
// voice channel that was empty (they're alone in it), the bot hops in and
// starts the 24/7 radio automatically — no command needed. It also leaves
// on its own once everyone's gone, so it doesn't sit idle in an empty
// channel burning resources.

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const guild = newState.guild;
    const session = getSessionInfo(guild.id);

    // --- Someone joined a channel — check if they're alone in it. ---
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

    // --- Someone left a channel — check if the bot is now alone there. ---
    const leftChannel = oldState.channel;
    if (leftChannel && oldState.channelId !== newState.channelId) {
      const botMember = await guild.members.fetchMe();
      const botIsThere = leftChannel.members.has(botMember.id);
      if (!botIsThere) return;

      const humansLeft = leftChannel.members.filter((m) => !m.user.bot).size;
      if (humansLeft === 0) {
        logger.info(`[${guild.id}] Everyone left #${leftChannel.name} — stopping and leaving.`);
        stopPlayback(guild.id, { manual: false });
      }
    }
  } catch (err) {
    logger.error('VoiceStateUpdate handler error:', err.message);
  }
});

// ---------------------------------------------------------------------------
// Slash command + button + autocomplete dispatch
// ---------------------------------------------------------------------------

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

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        logger.error(`Autocomplete error for /${interaction.commandName}:`, err.message);
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('player:')) {
    await handlePlayerButton(interaction);
  }
});

// ---------------------------------------------------------------------------
// Now Playing button controls
// ---------------------------------------------------------------------------

async function handlePlayerButton(interaction) {
  const guildId = interaction.guild.id;
  const action = interaction.customId.split(':')[1];

  try {
    switch (action) {
      case 'pauseresume':
        togglePause(guildId);
        break;
      case 'skip':
        skip(guildId);
        break;
      case 'volume_up':
        nudgeVolume(guildId, 1);
        break;
      case 'volume_down':
        nudgeVolume(guildId, -1);
        break;
      case 'stop':
        stopPlayback(guildId, { manual: true });
        break;
      default:
        break;
    }
    // The relevant service call already refreshes the Now Playing message;
    // we just need to acknowledge the interaction so Discord doesn't show
    // "This interaction failed" to the user who clicked.
    await interaction.deferUpdate();
  } catch (err) {
    await interaction.reply({ content: `❌ خطأ: ${err.message}`, ephemeral: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down…`);
  stopAllSessions();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

// ---------------------------------------------------------------------------
// Crash resilience — keep the 24/7 stream alive
// ---------------------------------------------------------------------------
// discord.js and the voice/network stack occasionally throw rejections that
// aren't fatal (e.g. a dropped request). Log and keep running for those.
// A genuinely uncaught exception can leave things in an inconsistent state,
// so we exit cleanly and let a process manager (pm2, see README) restart
// the bot immediately rather than limping along broken.

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — restarting:', err);
  // Best-effort — the process is exiting right after this, so we don't
  // await it, just give it a moment to actually leave the network.
  notify('🔴 Uncaught Exception — Restarting', `\`\`\`${String(err?.stack || err).slice(0, 1500)}\`\`\``, 'error');
  stopAllSessions();
  setTimeout(() => process.exit(1), 500);
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

client.login(config.discordToken).catch(async (err) => {
  logger.error('Login failed:', err.message);
  await notify('🔴 Login Failed', `\`\`\`${err.message}\`\`\``, 'error');
  process.exit(1);
});
