/**
 * yt-dlp is the single most common point of breakage for this bot — YouTube
 * changes things often enough that an old yt-dlp build can suddenly fail to
 * resolve audio URLs, even though nothing in this codebase changed. Rather
 * than waiting for a report of "no audio plays" and manually running
 * `yt-dlp -U`, do that check once at every startup.
 *
 * Entirely best-effort: if yt-dlp isn't on PATH, or `-U` isn't supported by
 * this install method (e.g. installed via winget/pip instead of the
 * standalone binary), this just logs and moves on — it never blocks or
 * fails startup.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger.js';
import { notify } from './webhook.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('ytdlp');

export async function checkForYtdlpUpdate() {
  let result;
  try {
    result = await execFileAsync('yt-dlp', ['-U'], { timeout: 30_000 });
  } catch (err) {
    // Non-zero exit or missing binary — don't treat this as fatal, just
    // surface it. `status.js` already reports version, so it's visible.
    logger.warn('yt-dlp self-update check failed (non-fatal):', err.message.split('\n')[0]);
    return;
  }

  const output = (result.stdout || '').trim();
  if (/up.to.date/i.test(output)) {
    logger.info('yt-dlp is up to date.');
    return;
  }

  if (/updated/i.test(output)) {
    logger.info(`yt-dlp self-updated: ${output.split('\n').pop()}`);
    await notify('🔄 yt-dlp Updated', `yt-dlp updated itself at startup:\n\`\`\`${output.slice(-500)}\`\`\``, 'info');
    return;
  }

  logger.info(`yt-dlp update check: ${output.split('\n').pop() || '(no output)'}`);
}
