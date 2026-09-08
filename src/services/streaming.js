/**
 * Audio streaming — yt-dlp → ffmpeg → PCM, plus process cleanup and pre-validation.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('audio');

export function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

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

export async function preValidateVideo(url) {
  return new Promise((resolve) => {
    const args = [
      '--simulate', '--no-warnings', '--no-playlist',
      '--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`,
    ];
    const browserCookieSource = process.env.COOKIE_BROWSER || 'edge';
    const cookiesPath = join(process.cwd(), 'cookies.txt');
    if (browserCookieSource !== 'none') {
      args.push('--cookies-from-browser', browserCookieSource);
    } else if (existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }
    args.push(url);
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill(); resolve(true); }, 5_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
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
    ];

    // Auto-extract cookies from Edge browser (logged into YouTube)
    // Falls back to cookies.txt if browser extraction fails
    const browserCookieSource = process.env.COOKIE_BROWSER || 'edge';
    const cookiesPath = join(process.cwd(), 'cookies.txt');

    if (browserCookieSource !== 'none') {
      ytDlpArgs.push('--cookies-from-browser', browserCookieSource);
    } else if (existsSync(cookiesPath)) {
      ytDlpArgs.push('--cookies', cookiesPath);
    }

    ytDlpArgs.push(
      '--socket-timeout', '30',
      '--retries', '5',
      '--fragment-retries', '5',
      youtubeUrl
    );

    const ffmpegArgs = [];
    if (startSeconds > 0) {
      ffmpegArgs.push('-ss', String(startSeconds));
    }
    ffmpegArgs.push(
      '-probesize', '32',
      '-analyzeduration', '0',
      '-i', 'pipe:0',
      '-bufsize', '64k',
      '-af', `volume=${volume / 100},afade=t=in:ss=0:d=0.4,aresample=48000`,
      '-vn',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    );

    const ytDlpProcess = spawn('yt-dlp', ytDlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.resolveProcess = ytDlpProcess;

    ytDlpProcess.stderr.on('data', () => {});

    ytDlpProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.ffmpegProcess = ffmpegProcess;

    ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

    ffmpegProcess.stdin.on('error', (err) => {
      if (err.code === 'EPIPE') return;
      logger.error(`ffmpeg stdin error: ${err.message}`);
    });

    ytDlpProcess.on('close', (code) => {
      session.resolveProcess = null;
      if (code !== 0 && code !== null) {
        try { ffmpegProcess.kill(); } catch {}
        safeReject(new Error(`yt-dlp exited with code ${code}`));
        return;
      }
      try { ffmpegProcess.stdin.end(); } catch {}
    });

    ffmpegProcess.stderr.on('data', () => {});

    ffmpegProcess.on('error', (err) => {
      safeReject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    let dataReceived = false;
    ffmpegProcess.stdout.once('data', () => {
      dataReceived = true;
      cleanup();
    });

    ffmpegProcess.on('close', (code) => {
      session.ffmpegProcess = null;
      if (!dataReceived && !resolved) {
        safeReject(new Error(`ffmpeg exited with code ${code} before producing audio`));
      }
    });

    logger.info(
      startSeconds > 0
        ? `Resuming from ${formatTime(startSeconds)}…`
        : 'Streaming audio…',
    );
    safeResolve({ stream: ffmpegProcess.stdout, ffmpegProcess });
  });
}
