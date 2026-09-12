// @ts-nocheck
import express from 'express';
import cors from 'cors';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from './logger.js';
import { loadPlays, getPlayHistory } from './stats.js';
import { getVideos } from '../services/youtube.js';
import { getConsecutiveAuthFails, getActiveProvider } from '../services/streaming.js';
import { getCookieInfo } from '../services/cookies.js';
import { getDb } from './database.js';
import { getLeaderboard } from '../services/community.js';
// Jingle event buffer — resolved lazily to avoid circular dep at load time
let peekJingleEvents = () => [];
import('../services/player/jingles.js')
    .then(m => { peekJingleEvents = m.peekJingleEvents; })
    .catch(() => { });
const logger = createLogger('dashboard');
const PORT = Number(process.env.STATUS_PORT) || 0;
const HOST = process.env.STATUS_HOST || '127.0.0.1';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
let getSessionInfoFn = null;
let getAllSessionsFn = null;
let executeCommandFn = null;
let getQueueFn = null;
// In-memory error log (last 1000 errors, auto-rotated)
const errorLog = [];
const MAX_ERROR_LOG = 1000;
export function logDashboardError(message, level = 'error') {
    errorLog.unshift({ message, level, time: new Date().toISOString() });
    if (errorLog.length > MAX_ERROR_LOG)
        errorLog.length = MAX_ERROR_LOG;
}
const sseClients = new Set();
export function broadcastTrackChange() {
    for (const client of sseClients) {
        try {
            client.write('data: update\n\n');
        }
        catch {
            sseClients.delete(client);
        }
    }
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
        sessions,
        topPlayed: sorted.map((entry) => ({ id: entry[0], title: entry[1].title, playCount: entry[1].playCount || entry[1].count || 0, lastPlayedAt: entry[1].lastPlayedAt })),
        history: getPlayHistory(15),
        errors: errorLog.slice(0, 20),
        timestamp: new Date().toISOString(),
    };
}
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
export function startStatusPage(getSessionInfoFnArg, getAllSessionsFnArg, executeCommandFnArg, getQueueFnArg) {
    if (!PORT)
        return;
    if (!DASHBOARD_TOKEN) {
        logger.warn('STATUS_PORT is set but DASHBOARD_TOKEN is empty — dashboard will NOT start (auth required).');
        return;
    }
    getSessionInfoFn = getSessionInfoFnArg;
    getAllSessionsFn = getAllSessionsFnArg || null;
    executeCommandFn = executeCommandFnArg || null;
    getQueueFn = getQueueFnArg || null;
    const app = express();
    app.use(cors());
    app.use(express.json());
    app.use(express.static(join(process.cwd(), 'public')));
    // Custom static fallbacks
    app.get('/live', (req, res) => res.sendFile(join(process.cwd(), 'public', 'live.html')));
    app.get('/admin/kiosk', (req, res) => res.sendFile(join(process.cwd(), 'public', 'kiosk.html')));
    // Security Headers Middleware
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    // No rate limiting — unlimited API access
    // Public Endpoints
    app.get('/health', async (req, res) => {
        const checks = { ok: true, uptime: Math.floor(process.uptime()) };
        await new Promise(resolve => {
            execFile('yt-dlp', ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
                checks.ytdlp = err ? 'unavailable' : stdout.trim();
                resolve();
            });
        });
        res.status(checks.ok ? 200 : 503).json(checks);
    });
    app.get('/api/public', async (req, res) => {
        try {
            res.json(await getPublicData());
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to fetch public data' });
        }
    });
    app.get('/api/sse', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
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
                guildId: active.guildId || null,
            } : null;
            // Read jingle events
            const since = Number(req.query.since) || 0;
            const jingles = peekJingleEvents().filter(e => e.at > since);
            res.json({ state, jingles, timestamp: Date.now() });
        }
        catch (err) {
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
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to fetch status' });
        }
    });
    app.get('/api/health', async (req, res) => {
        try {
            const health = { ytdlp: {}, pot: {}, cookie: {}, db: {} };
            await new Promise(resolve => {
                execFile('yt-dlp', ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
                    health.ytdlp.version = err ? 'unavailable' : stdout.trim();
                    health.ytdlp.ok = !err;
                    resolve();
                });
            });
            try {
                const r = await fetch(getActiveProvider(), { signal: AbortSignal.timeout(3000) });
                health.pot.ok = r.ok;
                health.pot.status = r.status;
                health.pot.activeProvider = getActiveProvider();
            }
            catch {
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
            }
            catch {
                health.db.ok = false;
            }
            res.json(health);
        }
        catch (err) {
            res.status(500).json({ error: 'Health check failed' });
        }
    });
    app.post('/api/command', async (req, res) => {
        try {
            const cmd = (req.body.command || '').trim();
            if (!cmd)
                return res.status(400).json({ error: 'No command provided' });
            if (executeCommandFn) {
                const reply = await Promise.resolve(executeCommandFn(cmd));
                res.json({ ok: true, reply: reply || 'Command executed.' });
            }
            else {
                res.json({ ok: true, reply: 'Command received: ' + cmd });
            }
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.get('/api/servers', (req, res) => {
        try {
            const sessions = getAllSessionsFn ? getAllSessionsFn() : [];
            res.json({ servers: sessions });
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to fetch servers' });
        }
    });
    app.get('/api/videos', async (req, res) => {
        try {
            const videos = await getVideos();
            const plays = await loadPlays();
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
            res.json({ videos: videosWithPlays });
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to fetch videos' });
        }
    });
    app.post('/api/play', async (req, res) => {
        try {
            const videoId = req.body.videoId;
            if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
                return res.status(400).json({ error: 'Invalid videoId format' });
            }
            if (executeCommandFn) {
                const reply = await Promise.resolve(executeCommandFn('play ' + videoId));
                res.json({ ok: true, reply: reply || 'Playing.' });
            }
            else {
                res.status(400).json({ error: 'executeCommandFn not available' });
            }
        }
        catch (e) {
            res.status(400).json({ error: 'Invalid request' });
        }
    });
    // Blacklist Management
    app.get('/api/blacklist', (req, res) => {
        try {
            const db = getDb();
            const rows = db.prepare('SELECT user_id, reason, added_at, added_by FROM blacklist ORDER BY added_at DESC').all();
            res.json({ blacklist: rows });
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to fetch blacklist' });
        }
    });
    app.post('/api/blacklist', (req, res) => {
        try {
            const { user_id, reason } = req.body;
            if (!user_id)
                return res.status(400).json({ error: 'user_id is required' });
            const db = getDb();
            db.prepare('INSERT OR REPLACE INTO blacklist (user_id, reason, added_by) VALUES (?, ?, ?)')
                .run(user_id, reason || 'Added via Dashboard', 'Admin');
            res.json({ ok: true, message: 'User added to blacklist' });
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to add to blacklist' });
        }
    });
    app.delete('/api/blacklist/:id', (req, res) => {
        try {
            const { id } = req.params;
            const db = getDb();
            const info = db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(id);
            if (info.changes > 0)
                res.json({ ok: true });
            else
                res.status(404).json({ error: 'User not found in blacklist' });
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to remove from blacklist' });
        }
    });
    app.listen(PORT, HOST, () => {
        logger.info(`Dashboard running on http://${HOST}:${PORT}`);
    }).on('error', (err) => {
        logger.warn('Dashboard failed to start:', err.message);
    });
}
