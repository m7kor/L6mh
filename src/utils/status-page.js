/**
 * Dashboard — full HTML status page with live API.
 * Auth: ALL API endpoints require DASHBOARD_TOKEN (env) via Authorization header.
 * Dashboard refuses to start if DASHBOARD_TOKEN is not set.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from './logger.js';
import { loadPlays, getPlayHistory } from './stats.js';
import { getVideos } from '../services/youtube.js';
import { getConsecutiveAuthFails } from '../services/streaming.js';
import { getCookieInfo } from '../services/cookies.js';
import { getDb } from './database.js';
import { getLeaderboard } from '../services/community.js';

const logger = createLogger('dashboard');

const PORT = Number(process.env.STATUS_PORT) || 0;
const HOST = process.env.STATUS_HOST || '127.0.0.1';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

function checkAuth(req, res) {
  if (!DASHBOARD_TOKEN) return false;
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${DASHBOARD_TOKEN}`;
  if (auth.length !== expected.length) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (timingSafeEqual(a, b)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

let getSessionInfoFn = null;
let getAllSessionsFn = null;
let executeCommandFn = null;
let getQueueFn = null;

let cachedHtml = null;

// In-memory error log (last 50 errors)
const errorLog = [];
const MAX_ERROR_LOG = 50;

// Simple in-memory rate limiter (excludes /api/status polling)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

function isRateLimited(ip, url) {
  // Exempt read-only polling endpoints
  if (url === '/api/status' || url === '/api/videos') return false;
  // Stricter limit for write endpoints
  const max = url === '/api/command' ? 30 : RATE_LIMIT_MAX;
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

// Periodic cleanup of rate limit map (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

export function logDashboardError(message) {
  errorLog.unshift({ message, time: new Date().toISOString() });
  if (errorLog.length > MAX_ERROR_LOG) errorLog.length = MAX_ERROR_LOG;
}

async function getApiData() {
  const plays = await loadPlays();
  
  let totalPlays = 0;
  for (const key in plays) {
    totalPlays += plays[key].playCount || plays[key].count || 0;
  }
  
  const sorted = Object.entries(plays)
    .sort((a, b) => (b[1].playCount || b[1].count || 0) - (a[1].playCount || a[1].count || 0))
    .slice(0, 10);

  let sessions = [];
  if (getAllSessionsFn) {
    sessions = getAllSessionsFn().map(session => ({
      ...session,
      elapsedSeconds: session.elapsedSeconds || 0,
      durationSeconds: session.durationSeconds || null,
      videoUrl: session.url || null,
    }));
  }

  return {
    uptime: process.uptime(),
    pid: process.pid,
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    guilds: sessions.length,
    totalPlays,
    sessions: sessions,
    topPlayed: sorted.map((entry) => {
      return { id: entry[0], title: entry[1].title, playCount: entry[1].playCount || entry[1].count || 0, lastPlayedAt: entry[1].lastPlayedAt };
    }),
    history: getPlayHistory(15),
    errors: errorLog.slice(0, 20),
    timestamp: new Date().toISOString(),
  };
}

/** Public data for the live page — no auth required. */
async function getPublicData() {
  const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
  const plays = await loadPlays();
  const videos = await getVideos();

  let totalPlays = 0;
  for (const key in plays) {
    totalPlays += plays[key].playCount || plays[key].count || 0;
  }

  const sorted = Object.entries(plays)
    .sort((a, b) => (b[1].playCount || b[1].count || 0) - (a[1].playCount || a[1].count || 0))
    .slice(0, 10);

  const activeSession = sessions.find(s => s.title) || sessions[0] || null;

  return {
    nowPlaying: activeSession ? {
      title: activeSession.title,
      videoId: activeSession.guildId ? (getSessionInfoFn?.(activeSession.guildId)?.current?.videoId || null) : null,
      mode: activeSession.mode,
      elapsed: activeSession.elapsedSeconds || 0,
      duration: activeSession.durationSeconds || null,
      paused: activeSession.paused || false,
    } : null,
    guilds: sessions.length,
    totalPlays,
    totalVideos: videos.length,
    uptimeHours: Math.floor(process.uptime() / 3600),
    topPlayed: sorted.map(([id, data]) => ({
      id,
      title: data.title,
      playCount: data.playCount || data.count || 0,
    })),
    history: await getPlayHistory(15),
    leaderboard: getLeaderboard(sessions[0]?.guildId || '', 10)
      .filter(e => e.minutes_present > 0)
      .map(e => ({
        userId: e.user_id,
        hours: Math.floor(e.minutes_present / 60),
        mins: e.minutes_present % 60,
      })),
  };
}

/** SSE broadcast — call this when track changes. */
const sseClients = new Set();

export function broadcastTrackChange() {
  for (const client of sseClients) {
    try {
      client.write('data: update\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}

export function startStatusPage(getSessionInfoFnArg, getAllSessionsFnArg, executeCommandFnArg, getQueueFnArg) {
  if (!PORT) return;

  if (!DASHBOARD_TOKEN) {
    logger.warn('STATUS_PORT is set but DASHBOARD_TOKEN is empty — dashboard will NOT start (auth required).');
    return;
  }

  getSessionInfoFn = getSessionInfoFnArg;
  getAllSessionsFn = getAllSessionsFnArg || null;
  executeCommandFn = executeCommandFnArg || null;
  getQueueFn = getQueueFnArg || null;

  try {
    const server = createServer(async (req, res) => {
      // Security headers
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');

      const ip = req.socket.remoteAddress || '';

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health endpoint — no auth, no data leakage
      if (req.url === '/health') {
        const checks = { ok: true, uptime: Math.floor(process.uptime()) };
        // Check yt-dlp availability
        await new Promise(resolve => {
          execFile('yt-dlp', ['--version'], { timeout: 5000 }, (err, stdout) => {
            checks.ytdlp = err ? 'unavailable' : stdout.trim();
            resolve();
          });
        });
        const code = checks.ok ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(checks));
        return;
      }

      // All API endpoints require auth (except public + SSE)
      if (req.url.startsWith('/api/') && req.url !== '/api/public' && req.url !== '/api/sse') {
        if (isRateLimited(ip, req.url)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many requests' }));
          return;
        }
        if (!checkAuth(req, res)) return;
      }

      // ── Public API (no auth) ──
      if (req.url === '/api/public') {
        try {
          const data = await getPublicData();
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to fetch public data' }));
        }
        return;
      }

      // ── SSE (no auth) ──
      if (req.url === '/api/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.url === '/api/status') {
        try {
          const data = await getApiData();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to fetch status' }));
        }
        return;
      }

      // ── Detailed Health (admin only) ──
      if (req.url === '/api/health') {
        try {
          const health = { ytdlp: {}, pot: {}, cookie: {}, db: {} };
          // yt-dlp version
          await new Promise(resolve => {
            execFile('yt-dlp', ['--version'], { timeout: 5000 }, (err, stdout) => {
              health.ytdlp.version = err ? 'unavailable' : stdout.trim();
              health.ytdlp.ok = !err;
              resolve();
            });
          });
          // PoT provider (uses Node 18+ built-in fetch)
          try {
            const r = await fetch(process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416', { signal: AbortSignal.timeout(3000) });
            health.pot.ok = r.ok;
            health.pot.status = r.status;
          } catch {
            health.pot.ok = false;
            health.pot.status = 'unreachable';
          }
          health.pot.consecutiveFails = getConsecutiveAuthFails();
          // Cookie
          health.cookie = getCookieInfo();
          // DB size
          try {
            const db = getDb();
            const row = db.prepare("SELECT page_count * page_size as bytes FROM pragma_page_count(), pragma_page_size()").get();
            health.db.bytes = row ? row.bytes : 0;
            health.db.ok = true;
          } catch {
            health.db.ok = false;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Health check failed' }));
        }
        return;
      }

      if (req.url === '/api/command' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            const cmd = (parsed.command || '').trim();
            
            if (!cmd) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No command provided' }));
              return;
            }
            
            if (executeCommandFn) {
              try {
                const reply = await Promise.resolve(executeCommandFn(cmd));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, reply: reply || 'Command executed.' }));
              } catch (cmdErr) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: cmdErr.message }));
              }
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, reply: 'Command received: ' + cmd }));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
          }
        });
        return;
      }

      if (req.url === '/api/servers' && req.method === 'GET') {
        try {
          const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ servers: sessions }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to fetch servers' }));
        }
        return;
      }

      if (req.url === '/api/videos' && req.method === 'GET') {
        try {
          const videos = await getVideos();
          const plays = await loadPlays();
          // Get queue position from first active session
          let queuePosMap = {};
          if (getQueueFn && getAllSessionsFn) {
            const sessions = getAllSessionsFn();
            for (const ses of sessions) {
              if (ses.guildId) {
                const queue = getQueueFn(ses.guildId);
                queue.forEach((vid, idx) => { queuePosMap[vid] = idx + 1; });
              }
            }
          }
          const videosWithPlays = videos.map(v => ({
            ...v,
            playCount: plays[v.videoId]?.playCount || plays[v.videoId]?.count || 0,
            lastPlayedAt: plays[v.videoId]?.lastPlayedAt || null,
            queuePos: queuePosMap[v.videoId] || 0,
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ videos: videosWithPlays }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to fetch videos: ' + err.message }));
        }
        return;
      }

      if (req.url === '/api/play' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            const videoId = parsed.videoId;
            if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid videoId format' }));
              return;
            }
            if (executeCommandFn) {
              const reply = await Promise.resolve(executeCommandFn('play ' + videoId));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, reply: reply || 'Playing.' }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'executeCommandFn not available' }));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      }

      // Static files — no auth needed (HTML/JS/CSS only)
      try {
        let filePath = req.url === '/' ? '/index.html' : req.url;
        if (filePath === '/live') filePath = '/live.html';
        if (filePath === '/admin/kiosk') filePath = '/kiosk.html';
        filePath = filePath.replace(/\.\./g, '');
        const fullPath = join(process.cwd(), 'public', filePath);
        
        const ext = fullPath.split('.').pop().toLowerCase();
        const mimeTypes = {
          'html': 'text/html; charset=utf-8',
          'js': 'application/javascript',
          'css': 'text/css',
          'json': 'application/json',
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'svg': 'image/svg+xml',
          'ico': 'image/x-icon'
        };
        const contentType = mimeTypes[ext] || 'text/plain';
        
        const content = await readFile(fullPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } catch (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });

    server.listen(PORT, HOST, () => {
      logger.info(`Dashboard running on http://${HOST}:${PORT}`);
    });

    server.on('error', (err) => {
      logger.warn('Dashboard failed to start:', err.message);
    });
  } catch (err) {
    logger.warn('Dashboard error:', err.message);
  }
}
