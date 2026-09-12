/**
 * Central configuration loader.
 * Lazy initialization: validates required environment variables on first
 * property access, not on import. This lets test files import modules
 * that depend on config without triggering process.exit().
 */

import 'dotenv/config';

const REQUIRED_VARS = ['DISCORD_TOKEN', 'CLIENT_ID', 'YOUTUBE_API_KEY', 'CHANNEL_ID'];

let _config = null;

function loadConfig() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required environment variable(s): ${missing.join(', ')}. `
      + 'Copy .env.example to .env and fill in the values.'
    );
  }

  return {
    discordToken: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    youtubeApiKey: process.env.YOUTUBE_API_KEY,
    channelId: process.env.CHANNEL_ID,
    healthWebhookUrl: process.env.HEALTH_WEBHOOK_URL || null,
    defaultVolume: clampNumber(Number(process.env.DEFAULT_VOLUME), 100, 0, 200),
    potProviderUrl: process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416',
  };
}

function clampNumber(value, fallback, min, max) {
  if (Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export interface AppConfig {
  discordToken: string;
  clientId: string;
  youtubeApiKey: string;
  channelId: string;
  healthWebhookUrl: string | null;
  defaultVolume: number;
  potProviderUrl: string;
}

/**
 * Lazy config proxy — validates on first property access.
 * In production, first access happens at boot (index.js → config.discordToken).
 * In tests, if no property is ever accessed, no validation occurs.
 */
export const config = new Proxy({} as AppConfig, {
  get(_, prop: keyof AppConfig) {
    if (!_config) _config = loadConfig();
    return _config[prop];
  },
}) as AppConfig;
