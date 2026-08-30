/**
 * Central configuration loader.
 * Validates required environment variables once, at startup,
 * so the rest of the app can trust `config` is complete.
 */

import 'dotenv/config';

const REQUIRED_VARS = ['DISCORD_TOKEN', 'CLIENT_ID', 'YOUTUBE_API_KEY', 'CHANNEL_ID'];

function loadConfig() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`[config] Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[config] Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }

  return {
    discordToken: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    youtubeApiKey: process.env.YOUTUBE_API_KEY,
    channelId: process.env.CHANNEL_ID,
    voiceChannelId: process.env.VOICE_CHANNEL_ID || null,
    // Optional: a Discord webhook URL for ops notifications (startup,
    // crashes, repeated rejoin failures, YouTube quota exhaustion). See
    // src/utils/webhook.js — everything degrades to a silent no-op if unset.
    healthWebhookUrl: process.env.HEALTH_WEBHOOK_URL || null,
    defaultVolume: clampNumber(Number(process.env.DEFAULT_VOLUME), 100, 0, 200),
    queuePreviewSize: clampNumber(Number(process.env.QUEUE_PREVIEW_SIZE), 5, 1, 20),
    // Ambient soundboard: three independent triggers, each toggleable.
    // 1) A random clip plays once right when the bot joins the voice
    //    channel, before the video/radio starts (a quick "intro").
    // 2) A random clip plays between tracks, right after one ends and
    //    before the next one starts (a "transition").
    // 3) (Optional, off by default) a random clip plays on a timer while
    //    playback is running, regardless of track boundaries.
    soundOnJoin: process.env.SOUND_ON_JOIN !== 'false',
    soundOnTrackEnd: process.env.SOUND_ON_TRACK_END !== 'false',
    soundEffectsEnabled: process.env.SOUND_EFFECTS_ENABLED === 'true',
    soundEffectsMinMinutes: clampNumber(Number(process.env.SOUND_EFFECTS_MIN_MINUTES), 8, 1, 1440),
    soundEffectsMaxMinutes: clampNumber(Number(process.env.SOUND_EFFECTS_MAX_MINUTES), 20, 1, 1440),
  };
}

function clampNumber(value, fallback, min, max) {
  if (Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export const config = loadConfig();