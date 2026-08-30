/**
 * Optional ops notifications via a Discord webhook.
 *
 * If HEALTH_WEBHOOK_URL is set in .env, the bot posts short embeds to it
 * for events you'd otherwise only see by tailing `pm2 logs`: startup,
 * crashes/restarts, repeated voice-rejoin failures, and YouTube quota
 * exhaustion. Entirely optional — every function here is a no-op if the
 * webhook isn't configured, so nothing else in the app needs to guard
 * against it being missing.
 */

import { config } from '../config.js';
import { createLogger } from './logger.js';

const logger = createLogger('webhook');

const COLORS = {
  info: 0x5865f2,
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  error: 0xed4245,
};

/**
 * Fire-and-forget: post an embed to the configured health webhook.
 * Never throws — a broken webhook shouldn't be able to affect playback.
 */
export async function notify(title, description, level = 'info') {
  if (!config.healthWebhookUrl) return;

  try {
    const res = await fetch(config.healthWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title,
            description,
            color: COLORS[level] ?? COLORS.info,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn(`Webhook post failed with status ${res.status}`);
    }
  } catch (err) {
    logger.warn('Webhook post failed:', err.message);
  }
}
