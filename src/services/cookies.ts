/**
 * Centralized cookie handling for yt-dlp.
 *
 * Resolves the correct cookie arguments based on environment:
 *  - COOKIE_BROWSER set (not "none") → --cookies-from-browser <browser>
 *  - cookies.txt exists               → --cookies <path>
 *  - neither                          → no cookie args (may fail for age-gated content)
 *
 * Single source of truth — streaming.js, player.js preload, and any future
 * yt-dlp call-site all call getCookieArgs().
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cookies');

const COOKIE_BROWSER = process.env.COOKIE_BROWSER || 'none';
const COOKIES_PATH = join(process.cwd(), 'cookies.txt');

let cookiesMissingWarned = false;

/**
 * Returns an array of yt-dlp arguments for cookie authentication.
 * Always returns an array (possibly empty) — safe to spread into any arg list.
 */
export function getCookieArgs() {
  if (COOKIE_BROWSER !== 'none') {
    return ['--cookies-from-browser', COOKIE_BROWSER];
  }

  if (existsSync(COOKIES_PATH)) {
    return ['--cookies', COOKIES_PATH];
  }

  if (!cookiesMissingWarned) {
    logger.warn(
      'No cookies configured (COOKIE_BROWSER=none and cookies.txt not found). '
      + 'Some videos may require authentication. See README for cookie setup.',
    );
    cookiesMissingWarned = true;
  }

  return [];
}

/**
 * Returns true if the cookie source is a cookies.txt file (server-side mode).
 */
export function isFileCookieMode() {
  return COOKIE_BROWSER === 'none';
}

/**
 * Returns the active cookie source description (for logging / dashboard).
 */
export function describeCookieSource() {
  if (COOKIE_BROWSER !== 'none') return `browser: ${COOKIE_BROWSER}`;
  if (existsSync(COOKIES_PATH)) return 'cookies.txt';
  return 'none (no authentication)';
}

/**
 * Returns cookie file info for health checks.
 */
export function getCookieInfo() {
  if (COOKIE_BROWSER !== 'none') return { source: COOKIE_BROWSER, type: 'browser', ageDays: null, stale: false };
  if (existsSync(COOKIES_PATH)) {
    const stat = statSync(COOKIES_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageDays = Math.floor(ageMs / 86400000);
    return { source: 'cookies.txt', type: 'file', ageDays, stale: ageDays > 14 };
  }
  return { source: 'none', type: 'none', ageDays: null, stale: true };
}
