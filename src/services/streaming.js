/**
 * Audio streaming — yt-dlp → ffmpeg → PCM, plus process cleanup and pre-validation.
 */

import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { formatTime } from '../utils/format.js';
import { getCookieArgs } from './cookies.js';
import { notify } from '../utils/webhook.js';

const logger = createLogger('audio');

let consecutiveAuthFails = 0;
const AUTH_FAIL_THRESHOLD = 3;
const STDERR_TAIL_BYTES = 2048;

export function killProcesses(session) {
  if (session.ffmpegProcess) {
    try { session.ffmpegProcess.kill('SIGKILL'); } catch {}
    session.ffmpegProcess = null;
  }
  if (session.resolveProcess) {
    try { session.resolveProcess.kill('SIGKILL'); } catch {}
    session.resolveProcess = null;
  }
}

/** Check if stderr mentions the PoT provider being unreachable. */
export function isPotProviderError(stderr) {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();
  return (lower.includes('econnrefused') || lower.includes('connection refused')
    || lower.includes('etimedout') || lower.includes('connection timed out'))
    && lower.includes('bgutil');
}

export async function preValidateVideo(url) {
  return new Promise((resolve) => {
    const args = [
      '--simulate', '--no-warnings', '--no-playlist',
      '--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`,
      ...getCookieArgs(),
      url,
    ];
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
    });
    const timer = setTimeout(() => { proc.kill(); resolve(true); }, 5_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        consecutiveAuthFails = 0;
        resolve(true);
      } else {
        consecutiveAuthFails++;
        if (isPotProviderError(stderrTail)) {
          notify(
            '⚠️ PoT غير متاح',
            `تعذر الاتصال بـ \`${config.potProviderUrl}\``,
            'error',
          ).catch(() => {});
        } else if (consecutiveAuthFails >= AUTH_FAIL_THRESHOLD) {
          notify(
            '⚠️ تعذر التحقق',
            `فشل yt-dlp ${consecutiveAuthFails} مرات متتالية — تحقق من الكوكيز`,
            'error',
          ).catch(() => {});
          consecutiveAuthFails = 0;
        }
        resolve(false);
      }
    });
    proc.on('error', () => { clearTimeout(timer); resolve(true); });
  });
}

export function createAudioStream(session, youtubeUrl, startSeconds = 0, volume = 100) {
  return new Promise((resolve, reject) => {
    const STREAM_TIMEOUT_MS = 45_000;
    let resolved = false;
    let streamTimeout = null;

    function cleanup() {
      if (streamTimeout) { clearTimeout(streamTimeout); streamTimeout = null; }
    }

    function safeReject(err) {
      if (resolved) return;
      resolved = true;
      cleanup();
      killProcesses(session);
      reject(err);
    }

    function safeResolve(val) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(val);
    }

    streamTimeout = setTimeout(() => {
      safeReject(new Error('Stream timeout — no audio data received'));
    }, STREAM_TIMEOUT_MS);

    const ytDlpArgs = [
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '-o', '-',
      '--no-part',
      '--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`,
      ...getCookieArgs(),
    ];

    ytDlpArgs.push(
      '--socket-timeout', '30',
      '--retries', '5',
      '--fragment-retries', '10',
      '--retry-sleep', '2',
      youtubeUrl,
    );

    const ffmpegArgs = [];
    if (startSeconds > 0) {
      ffmpegArgs.push('-ss', String(startSeconds));
    }
    ffmpegArgs.push(
      '-probesize', '32768',
      '-analyzeduration', '0',
      '-i', 'pipe:0',
      '-bufsize', '512k',
      '-af', `volume=${volume / 100},afade=t=in:ss=0:d=0.4,aresample=48000`,
      '-vn',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    );

    const ytDlpProcess = spawn('yt-dlp', ytDlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    session.resolveProcess = ytDlpProcess;

    let ytDlpStderr = '';
    ytDlpProcess.stderr.on('data', (chunk) => {
      ytDlpStderr += chunk.toString();
      if (ytDlpStderr.length > STDERR_TAIL_BYTES) ytDlpStderr = ytDlpStderr.slice(-STDERR_TAIL_BYTES);
    });

    ytDlpProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    session.ffmpegProcess = ffmpegProcess;

    ytDlpProcess.stdout.on('error', (err) => {
      if (!ffmpegProcess.killed) {
        try { ffmpegProcess.kill('SIGKILL'); } catch {}
      }
    });
    ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

    ffmpegProcess.stdin.on('error', (err) => {
      if (err.code === 'EPIPE') return;
      logger.error(`ffmpeg stdin error: ${err.message}`);
    });

    ytDlpProcess.on('close', (code) => {
      session.resolveProcess = null;
      if (code !== 0 && code !== null) {
        try { ffmpegProcess.kill(); } catch {}
        const snippet = ytDlpStderr.slice(-500).trim();
        const detail = snippet ? `\n${snippet}` : '';
        if (isPotProviderError(ytDlpStderr)) {
          safeReject(new Error(`yt-dlp failed — PoT provider unreachable at ${config.potProviderUrl}${detail}`));
        } else {
          safeReject(new Error(`yt-dlp exited with code ${code}${detail}`));
        }
        return;
      }
      try { ffmpegProcess.stdin.end(); } catch {}
    });

    let ffmpegStderr = '';
    ffmpegProcess.stderr.on('data', (chunk) => {
      ffmpegStderr += chunk.toString();
      if (ffmpegStderr.length > STDERR_TAIL_BYTES) ffmpegStderr = ffmpegStderr.slice(-STDERR_TAIL_BYTES);
    });

    ffmpegProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    let dataReceived = false;

    const bufferingStream = new PassThrough({ highWaterMark: 1024 * 128 });
    ffmpegProcess.stdout.pipe(bufferingStream);

    bufferingStream.once('data', () => {
      dataReceived = true;
      cleanup();
      safeResolve({ stream: bufferingStream, ffmpegProcess });
    });

    ffmpegProcess.on('close', (code) => {
      session.ffmpegProcess = null;
      if (!dataReceived && !resolved) {
        const snippet = ffmpegStderr.slice(-500).trim();
        const detail = snippet ? `\n${snippet}` : '';
        safeReject(new Error(`ffmpeg exited with code ${code} before producing audio${detail}`));
      }
    });

    logger.info(
      startSeconds > 0
        ? `Resuming from ${formatTime(startSeconds)}…`
        : 'Streaming audio…',
    );
  });
}
