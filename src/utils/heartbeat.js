/**
 * Local heartbeat file for external monitoring.
 *
 * Writes a timestamp to heartbeat.json on a configurable interval.
 * External tools (cron, uptime checkers) can read the file's mtime
 * to confirm the bot is alive. Dependency-free, non-blocking.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('heartbeat');

const HEARTBEAT_FILE = join(process.cwd(), 'heartbeat.json');
const INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 60_000;

let timer = null;

function writeHeartbeat() {
  try {
    writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      alive: true,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    }));
  } catch (err) {
    logger.warn('Failed to write heartbeat:', err.message);
  }
}

export function startHeartbeat() {
  if (timer) return;
  writeHeartbeat();
  timer = setInterval(writeHeartbeat, INTERVAL_MS);
  logger.info(`Heartbeat started (every ${INTERVAL_MS / 1000}s)`);
}

export function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
