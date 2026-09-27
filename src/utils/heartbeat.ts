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
let getActiveProcessCountFn = null;
let getHealthFn = null;

/** RSS above which we log loudly. See `.env.example` for the PM2 limit. */
const HIGH_MEMORY_MB = 300;

function getMemoryMB() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heap: Math.round(mem.heapUsed / 1024 / 1024),
  };
}

export function setProcessCounter(fn) {
  getActiveProcessCountFn = fn;
}

/**
 * Register a richer health probe (gateway state, reaper tally).
 *
 * `alive: true`, written unconditionally on a timer that keeps running no
 * matter what the bot is doing, cannot tell a working radio from a deaf one.
 * And `processes: 4` against an expected 2 was the only outward hint that a
 * preloaded stream had been orphaned — with nothing reading the file, nothing
 * acted on it either.
 */
export function setHealthProbe(fn) {
  getHealthFn = fn;
}

function writeHeartbeat() {
  try {
    const mem = getMemoryMB();
    const data: any = {
      alive: true,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      memory: mem,
    };
    if (getActiveProcessCountFn) {
      data.processes = getActiveProcessCountFn();
    }
    if (getHealthFn) {
      try { data.health = getHealthFn(); } catch { data.health = null; }
    }
    writeFileSync(HEARTBEAT_FILE, JSON.stringify(data));
    if (mem.rss > HIGH_MEMORY_MB) {
      logger.warn(`High memory usage: ${mem.rss}MB RSS`);
      if (global.gc) global.gc();
    }
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
