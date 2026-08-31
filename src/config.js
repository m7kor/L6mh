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
    healthWebhookUrl: process.env.HEALTH_WEBHOOK_URL || null,
    defaultVolume: clampNumber(Number(process.env.DEFAULT_VOLUME), 100, 0, 200),
    potProviderUrl: process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416',
  };
}

function clampNumber(value, fallback, min, max) {
  if (Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export const config = loadConfig();
