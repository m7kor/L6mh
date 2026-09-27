import express from 'express';
import cors from 'cors';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from './logger.js';
import { loadPlays, getPlayHistory } from './stats.js';
import { getVideos } from '../services/youtube.js';
import { getConsecutiveAuthFails, getActiveProvider } from '../services/streaming.js';
import { getCookieInfo } from '../services/cookies.js';
import { getDb } from './database.js';
import { getLeaderboard, getUserBadges, backfillUsernames } from '../services/community.js';
import { isValidVideoId } from './validators.js';
import { selectPublicSession } from './playback-state.js';
import { validateDiscordInviteUrl } from './discord-invite.js';

// Jingle event buffer — resolved lazily to avoid circular dep at load time
let peekJingleEvents = () => [];
import('../services/player/jingles.js')
  .then(m => { peekJingleEvents = m.peekJingleEvents; })
  .catch(() => {});

const logger = createLogger('dashboard');

const PORT = Number(process.env.STATUS_PORT) || 0;
const HOST = process.env.STATUS_HOST || '127.0.0.1';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

/**
 * Resolve the public directory from this module's own location.
 *
 * `process.cwd()` is whatever directory the supervisor happened to start the
 * process in, so serving static files from there meant the dashboard silently
 * 404s when pm2 or Docker started the bot from anywhere else.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

/**
 * Cached `yt-dlp --version`.
 *
 * `/health` is unauthenticated, is the Docker healthcheck target, and used to
 * spawn a fresh `yt-dlp` process on every single call. At a 30s healthcheck
 * interval that is a child process every 30 seconds, forever — and an
 * unauthenticated request loop is a trivial way to force it at any rate.
 */
let ytdlpVersionCache: { value: string; ok: boolean; at: number } | null = null;
const YTDLP_VERSION_TTL_MS = 5 * 60 * 1000;

function getYtdlpVersion(): Promise<{ value: string; ok: boolean }> {
  if (ytdlpVersionCache && Date.now() - ytdlpVersionCache.at < YTDLP_VERSION_TTL_MS) {
    return Promise.resolve({ value: ytdlpVersionCache.value, ok: ytdlpVersionCache.ok });
  }
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const result = err
        ? { value: 'unavailable', ok: false }
        : { value: stdout.trim(), ok: true };
      // Only a successful probe is worth caching: a transient failure should
      // not keep reporting "unavailable" for the next five minutes.
      ytdlpVersionCache = { ...result, at: Date.now() };
      resolve({ value: result.value, ok: result.ok });
    });
  });
}

let getSessionInfoFn = null;
let getAllSessionsFn = null;
let executeCommandFn = null;
let getQueueFn = null;
let discordClient = null;

export function setDiscordClient(client) {
  discordClient = client;
}

/**
 * Whether the gateway is actually connected.
 *
 * Nothing in the shipped observability could tell a live bot from a deaf one.
 * The heartbeat wrote `alive: true` on a timer that keeps ticking regardless of
 * connectivity, and the healthcheck only tested the `yt-dlp` binary — so a bot
 * that had lost its gateway, or a voice connection that never reached `Ready`,
 * reported perfectly healthy indefinitely. `ws.ping` going stale is the one
 * signal that distinguishes "quiet" from "disconnected".
 */
function getGatewayHealth(): { connected: boolean; ping: number | null } {
  const ping = discordClient?.ws?.ping;
  return {
    connected: Boolean(discordClient?.ws?.ping != null && discordClient.isReady()),
    ping: typeof ping === 'number' && Number.isFinite(ping) ? ping : null,
  };
}

// In-memory error log (last 1000 errors, auto-rotated)
const errorLog: { message: string; level: string; time: string }[] = [];
const MAX_ERROR_LOG = 1000;

export function logDashboardError(message, level = 'error') {
  errorLog.unshift({ message, level, time: new Date().toISOString() });
  if (errorLog.length > MAX_ERROR_LOG) errorLog.length = MAX_ERROR_LOG;
}

const sseClients = new Set<express.Response>();
/**
 * How often to emit a comment frame on an idle stream.
 *
 * Only `trackChange` events were ever written, so a stream with no track
 * changes produced no bytes at all. Any reverse proxy with an idle timeout
 * closed the connection, and the client then churned reconnect-then-refetch
 * cycles against `/api/status` — turning a quiet radio into the chatty one.
 */
const SSE_KEEPALIVE_MS = 25_000;
const MAX_SSE_CLIENTS = 50;

export function broadcastTrackChange() {
  for (const client of sseClients) {
    try {
      client.write('data: update\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}

function startSseKeepalive() {
  const timer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, SSE_KEEPALIVE_MS);
  // Never hold the process open just to say "still here".
  timer.unref?.();
  return timer;
}

// Simple plays cache — avoids hitting SQLite on every request
let playsCache: { data: Record<string, any> | null; ts: number } = { data: null, ts: 0 };
const PLAYS_CACHE_TTL_MS = 5_000;

async function getApiData() {
  const now = Date.now();
  let plays = playsCache.data;
  if (!plays || now - playsCache.ts > PLAYS_CACHE_TTL_MS) {
    plays = await loadPlays();
    playsCache = { data: plays, ts: now };
  }
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

  // Add sleep timer remaining for each session
  let getRemainingMsFn: ((guildId: string) => number) | null = null;
  try {
    const mod = await import('../commands/sleeptimer.js');
    getRemainingMsFn = mod.getRemainingMs;
  } catch {}
  if (getRemainingMsFn) {
    sessions = sessions.map(s => ({
      ...s,
      sleepTimerRemainingMs: getRemainingMsFn!(s.guildId),
    }));
  }

  return {
    uptime: process.uptime(),
    pid: process.pid,
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    guilds: sessions.length,
    totalPlays,
    sessions,
    topPlayed: sorted.map((entry) => ({ id: entry[0], title: entry[1].title, playCount: entry[1].playCount || entry[1].count || 0, lastPlayedAt: entry[1].lastPlayedAt })),
    history: getPlayHistory(15),
    errors: errorLog.slice(0, 20),
    timestamp: new Date().toISOString(),
  };
}

async function getPublicData() {
  const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
  const videos = await getVideos();

  // Use cached plays (same cache as getApiData)
  const now = Date.now();
  let plays = playsCache.data;
  if (!plays || now - playsCache.ts > PLAYS_CACHE_TTL_MS) {
    plays = await loadPlays();
    playsCache = { data: plays, ts: now };
  }

  let totalPlays = 0;
  for (const key in plays) {
    totalPlays += plays[key].playCount || plays[key].count || 0;
  }
  const sorted = Object.entries(plays)
    .sort((a, b) => (b[1].playCount || b[1].count || 0) - (a[1].playCount || a[1].count || 0))
    .slice(0, 10);

  const activeSession = selectPublicSession(sessions);

  return {
    nowPlaying: activeSession ? {
      title: activeSession.title,
      videoId: activeSession.videoId ?? (activeSession.guildId ? (getSessionInfoFn?.(activeSession.guildId)?.current?.videoId || null) : null),
      mode: activeSession.mode,
      elapsed: activeSession.elapsedSeconds || 0,
      duration: activeSession.durationSeconds || null,
      paused: activeSession.paused || false,
      playbackState: activeSession.playbackState || 'unknown',
    } : null,
    guilds: sessions.length,
    playbackState: activeSession?.playbackState || 'idle',
    timestamp: new Date().toISOString(),
    discordInviteUrl: validateDiscordInviteUrl(process.env.DISCORD_INVITE_URL),
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

  const app = express();

  // The rate limiter keys on `req.ip`, which is the socket address unless the
  // proxy hop is declared. Behind the reverse proxy this deployment implies
  // (CORS_ORIGINS, STATUS_HOST), every client collapses into a single bucket:
  // the limit becomes a global 30 mutations/minute for everyone while giving
  // any one caller no protection at all.
  app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1);

  // CORS: only the configured origins, if any. An unset CORS_ORIGINS used to
  // fall through to `origin: undefined`, which the cors package renders as
  // `Access-Control-Allow-Origin: *` — so the public endpoints handed now
  // playing titles, play history, uptime, the leaderboard and the invite URL
  // to any origin on the internet. These routes carry no credentials, so this
  // was disclosure rather than CSRF, but it needed no configuration to happen.
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowedOrigins.length === 0) {
    logger.warn('CORS_ORIGINS is not set — cross-origin requests will be refused. Set it to the dashboard\'s public origin.');
  }
  app.use(cors({
    origin(origin, callback) {
      // Same-origin and non-browser callers send no Origin header.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(PUBLIC_DIR));

  // Custom static fallbacks
  app.get('/live', (req, res) => res.sendFile(join(PUBLIC_DIR, 'live.html')));
  app.get('/admin/kiosk', (req, res) => res.sendFile(join(PUBLIC_DIR, 'kiosk.html')));

  // Security Headers Middleware
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Simple in-memory rate limiter for mutation endpoints
  const rateLimits = new Map<string, { start: number; count: number }>();
  const RATE_WINDOW_MS = 60_000;
  const RATE_MAX = 30;
  function checkRateLimit(ip) {
    const now = Date.now();
    const entry = rateLimits.get(ip);
    if (!entry || now - entry.start > RATE_WINDOW_MS) {
      rateLimits.set(ip, { start: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_MAX;
  }
  // Clean up stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
      if (now - entry.start > RATE_WINDOW_MS * 2) rateLimits.delete(ip);
    }
  }, 300_000).unref?.();

  const sseKeepalive = startSseKeepalive();

  // Request logging middleware — logs all API requests with timing
  const apiLog: any[] = [];
  const MAX_API_LOG = 500;
  app.use('/api', (req, res, next) => {
    const start = Date.now();
    const ip = req.ip || req.socket.remoteAddress || '';
    res.on('finish', () => {
      const ms = Date.now() - start;
      const entry = { method: req.method, path: req.path, status: res.statusCode, ms, ip, time: new Date().toISOString() };
      apiLog.unshift(entry);
      if (apiLog.length > MAX_API_LOG) apiLog.length = MAX_API_LOG;
      if (res.statusCode >= 400 || ms > 5000) {
        logger.warn(`${req.method} ${req.path} ${res.statusCode} ${ms}ms from ${ip}`);
      }
    });
    next();
  });

  // Public Endpoints
  app.get('/health', async (req, res) => {
    // The Docker healthcheck hits this every 30s and it is unauthenticated,
    // so it shares the same per-IP budget as the mutation endpoints.
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }
    const ytdlp = await getYtdlpVersion();
    res.status(ytdlp.ok ? 200 : 503).json({
      ok: ytdlp.ok,
      uptime: Math.floor(process.uptime()),
      ytdlp: ytdlp.value,
      gateway: getGatewayHealth(),
    });
  });

  app.get('/api/public', async (req, res) => {
    try {
      res.json(await getPublicData());
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch public data' });
    }
  });

  app.get('/api/sse', (req, res) => {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return res.status(429).json({ error: 'Too many SSE connections' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Tell the browser how long to wait before reconnecting, and prove the pipe
    // works before the client starts polling for the initial state.
    res.write('retry: 5000\n\n');
    res.write('data: update\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // Activity state endpoint — public, no auth, polled by activity server
  app.get('/api/activity/state', (req, res) => {
    try {
      const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
      const active = sessions.find(s => s.title) || sessions[0] || null;

      const state = active ? {
        videoId: active.videoId || null,
        title: active.title || null,
        elapsedSeconds: active.elapsedSeconds || 0,
        durationSeconds: active.durationSeconds || null,
        paused: active.paused || false,
      } : null;

      // Read jingle events
      const since = Number(req.query.since) || 0;
      const jingles = peekJingleEvents().filter(e => e.at > since);

      res.json({ state, jingles, timestamp: Date.now() });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch activity state' });
    }
  });

  // Auth Middleware — timing-safe comparison
  app.use('/api', (req, res, next) => {
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${DASHBOARD_TOKEN}`;
    if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // Protected API Endpoints
  app.get('/api/status', async (req, res) => {
    try {
      res.json(await getApiData());
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch status' });
    }
  });

  app.get('/api/health', async (req, res) => {
    try {
      const health: Record<string, any> = { ytdlp: {}, pot: {}, cookie: {}, db: {}, processes: {}, gateway: getGatewayHealth() };
      const ytdlp = await getYtdlpVersion();
      health.ytdlp.version = ytdlp.value;
      health.ytdlp.ok = ytdlp.ok;
      try {
        const { getActiveProcessCount, getOrphanProcessCount } = await import('../services/streaming.js');
        health.processes.active = getActiveProcessCount();
        health.processes.orphans = getOrphanProcessCount();
      } catch { health.processes.active = -1; }
      try {
        const r = await fetch(getActiveProvider(), { signal: AbortSignal.timeout(3000) });
        health.pot.ok = r.ok;
        health.pot.status = r.status;
        health.pot.activeProvider = getActiveProvider();
      } catch {
        health.pot.ok = false;
        health.pot.status = 'unreachable';
      }
      health.pot.consecutiveFails = getConsecutiveAuthFails();
      health.cookie = getCookieInfo();
      try {
        const db = getDb();
        const row = db.prepare("SELECT page_count * page_size as bytes FROM pragma_page_count(), pragma_page_size()").get();
        health.db.bytes = row ? row.bytes : 0;
        health.db.ok = true;
      } catch {
        health.db.ok = false;
      }
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // Command whitelist — only these prefixes are allowed from dashboard
  const CMD_WHITELIST = ['help', 'status', 'np', 'nowplaying', 'random', 'عشوائي', 'resume', 'كمل', 'latest', 'اخر_مقطع', 'pause', 'stop', 'ايقاف', 'skip', 'تخطي', 'volume', 'صوت', 'play', 'search', 'بحث', 'qrm', 'qtop', 'top'];

  app.post('/api/command', async (req, res) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || '';
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
      const cmd = (req.body.command || '').trim();
      let targetGuildId = req.body.guildId || null;
      if (!cmd) return res.status(400).json({ error: 'No command provided' });

      // Validate guildId against known sessions
      if (targetGuildId) {
        const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
        if (!sessions.some(s => s.guildId === targetGuildId)) {
          targetGuildId = null; // ignore invalid guildId, broadcast to all
        }
      }

      // Validate command against whitelist
      const cmdLower = cmd.toLowerCase().trim();
      const allowed = CMD_WHITELIST.some(prefix => cmdLower === prefix || cmdLower.startsWith(prefix + ' '));
      if (!allowed) {
        return res.status(400).json({ error: 'Unknown command' });
      }

      // Validate play sub-command videoId
      if (cmdLower.startsWith('play ')) {
        const videoId = cmd.slice(5).trim();
        if (!isValidVideoId(videoId)) {
          return res.status(400).json({ error: 'Invalid video ID' });
        }
      }
      
      if (executeCommandFn) {
        const reply = await Promise.resolve(executeCommandFn(cmd, targetGuildId));
        res.json({ ok: true, reply: reply || 'Command executed.' });
      } else {
        res.json({ ok: true, reply: 'Command received: ' + cmd });
      }
    } catch (e) {
      res.status(500).json({ error: 'Command execution failed' });
    }
  });

  app.get('/api/servers', (req, res) => {
    try {
      const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
      res.json({ servers: sessions });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch servers' });
    }
  });

  app.get('/api/videos', async (req, res) => {
    try {
      const videos = await getVideos();
      const plays = await loadPlays();
      const queuePosMap: Record<string, number> = {};
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
      res.json({ videos: videosWithPlays });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch videos' });
    }
  });

  app.post('/api/play', async (req, res) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || '';
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
      const videoId = req.body.videoId;
      if (!isValidVideoId(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId format' });
      }
      if (executeCommandFn) {
        const reply = await Promise.resolve(executeCommandFn('play ' + videoId));
        res.json({ ok: true, reply: reply || 'Playing.' });
      } else {
        res.status(400).json({ error: 'executeCommandFn not available' });
      }
    } catch (e) {
      res.status(400).json({ error: 'Invalid request' });
    }
  });

  // Leaderboard endpoint
  app.get('/api/leaderboard', (req, res) => {
    try {
      const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
      const guildId = sessions[0]?.guildId || '';
      const lb = getLeaderboard(guildId, 20);
      const result = lb
        .filter((e: any) => e.minutes_present > 0)
        .map((e: any, i: number) => ({
          rank: i + 1,
          userId: e.user_id,
          username: e.username || null,
          avatarUrl: e.avatar_url || null,
          minutes: e.minutes_present,
          hours: Math.floor(e.minutes_present / 60),
          sessions: e.sessions_count,
          points: e.points || 0,
          badges: getUserBadges(e.user_id, guildId).map((b: any) => ({ emoji: b.emoji, name: b.name })),
        }));
      res.json({ leaderboard: result });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // Backfill usernames from Discord
  app.post('/api/backfill-usernames', async (req, res) => {
    try {
      // This one fans out into one Discord REST call per row in the table, so
      // it was the only mutation endpoint with no rate limit at all.
      const ip = req.ip || req.socket.remoteAddress || '';
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
      if (!discordClient) return res.status(503).json({ error: 'Discord client not available' });
      const total = await backfillUsernames(discordClient);
      res.json({ ok: true, updated: total });
    } catch (err) {
      res.status(500).json({ error: 'Backfill failed' });
    }
  });

  // Favorites endpoints
  app.get('/api/favorites', (req, res) => {
    try {
      const userId = req.query.user_id as string || 'dashboard';
      const db = getDb();
      const rows = db.prepare(`
        SELECT f.user_id, f.video_id, f.added_at, pc.title
        FROM favorites f
        LEFT JOIN play_counts pc ON pc.video_id = f.video_id
        WHERE f.user_id = ?
        ORDER BY f.added_at DESC
        LIMIT 100
      `).all(userId);
      res.json({ favorites: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch favorites' });
    }
  });

  app.post('/api/favorites', (req, res) => {
    try {
      const { video_id, user_id } = req.body;
      if (!isValidVideoId(video_id)) {
        return res.status(400).json({ error: 'Invalid videoId' });
      }
      const uid = user_id || 'dashboard';
      const db = getDb();
      const existing = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?').get(uid, video_id);
      if (existing) {
        return res.json({ ok: true, already: true });
      }
      db.prepare('INSERT INTO favorites (user_id, video_id) VALUES (?, ?)').run(uid, video_id);
      res.json({ ok: true, already: false });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add favorite' });
    }
  });

  app.delete('/api/favorites/:videoId', (req, res) => {
    try {
      const { videoId } = req.params;
      if (!isValidVideoId(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
      }
      const userId = (req.query.user_id as string) || 'dashboard';
      const db = getDb();
      db.prepare('DELETE FROM favorites WHERE video_id = ? AND user_id = ?').run(videoId, userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to remove favorite' });
    }
  });

  // Blacklist Management
  app.get('/api/blacklist', (req, res) => {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT user_id, reason, added_at, added_by FROM blacklist ORDER BY added_at DESC').all();
      res.json({ blacklist: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch blacklist' });
    }
  });

  app.post('/api/blacklist', (req, res) => {
    try {
      const { user_id, reason } = req.body;
      if (!user_id) return res.status(400).json({ error: 'user_id is required' });
      
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO blacklist (user_id, reason, added_by) VALUES (?, ?, ?)')
        .run(user_id, reason || 'Added via Dashboard', 'Admin');
      res.json({ ok: true, message: 'User added to blacklist' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add to blacklist' });
    }
  });

  app.delete('/api/blacklist/:id', (req, res) => {
    try {
      const { id } = req.params;
      const db = getDb();
      const info = db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(id);
      if (info.changes > 0) res.json({ ok: true });
      else res.status(404).json({ error: 'User not found in blacklist' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to remove from blacklist' });
    }
  });

  app.get('/api/logs', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json({ logs: apiLog.slice(0, limit) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch logs' });
    }
  });

  app.listen(PORT, HOST, () => {
    logger.info(`Dashboard running on http://${HOST}:${PORT}`);
  }).on('error', (err) => {
    logger.warn('Dashboard failed to start:', err.message);
    clearInterval(sseKeepalive);
  });
}
