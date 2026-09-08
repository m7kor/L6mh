/**
 * Dashboard — full HTML status page with live API.
 * Auth: mutating endpoints require DASHBOARD_TOKEN (env) via Authorization header.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { loadPlays, getPlayHistory } from './stats.js';
import { getVideos } from '../services/youtube.js';

const logger = createLogger('dashboard');

const PORT = Number(process.env.STATUS_PORT) || 0;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

function checkAuth(req, res) {
  if (!DASHBOARD_TOKEN) return true; // no token configured = open (local dev)
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${DASHBOARD_TOKEN}`) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

let getSessionInfoFn = null;
let getAllSessionsFn = null;
let executeCommandFn = null;

let cachedHtml = null;

// In-memory error log (last 50 errors)
const errorLog = [];
const MAX_ERROR_LOG = 50;

export function logDashboardError(message) {
  errorLog.unshift({ message, time: new Date().toISOString() });
  if (errorLog.length > MAX_ERROR_LOG) errorLog.length = MAX_ERROR_LOG;
}

async function getApiData() {
  const plays = await loadPlays();
  
  let totalPlays = 0;
  for (const key in plays) {
    totalPlays += plays[key].count || 0;
  }
  
  const sorted = Object.entries(plays)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
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
      return { id: entry[0], title: entry[1].title, count: entry[1].count, lastPlayedAt: entry[1].lastPlayedAt };
    }),
    history: getPlayHistory(15),
    errors: errorLog.slice(0, 20),
    timestamp: new Date().toISOString(),
  };
}

export function startStatusPage(getSessionInfoFnArg, getAllSessionsFnArg, executeCommandFnArg) {
  if (!PORT) return;
  getSessionInfoFn = getSessionInfoFnArg;
  getAllSessionsFn = getAllSessionsFnArg || null;
  executeCommandFn = executeCommandFnArg || null;

  try {
    const server = createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
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

      if (req.url === '/api/command' && req.method === 'POST') {
        if (!checkAuth(req, res)) return;
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

      if (req.url === '/api/skip' && req.method === 'POST') {
        if (!checkAuth(req, res)) return;
        if (executeCommandFn) {
          try {
            await Promise.resolve(executeCommandFn('skip'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'executeCommandFn not available' }));
        }
        return;
      }

      if (req.url === '/api/volume' && req.method === 'POST') {
        if (!checkAuth(req, res)) return;
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed.volume !== 'number') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Volume must be a number' }));
              return;
            }
            if (executeCommandFn) {
              await Promise.resolve(executeCommandFn('volume ' + parsed.volume));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'executeCommandFn not available' }));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
          }
        });
        return;
      }

      if (req.url === '/api/pause' && req.method === 'POST') {
        if (!checkAuth(req, res)) return;
        if (executeCommandFn) {
          try {
            await Promise.resolve(executeCommandFn('pause'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'executeCommandFn not available' }));
        }
        return;
      }

      if (req.url === '/api/resume' && req.method === 'POST') {
        if (!checkAuth(req, res)) return;
        if (executeCommandFn) {
          try {
            await Promise.resolve(executeCommandFn('unpause'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'executeCommandFn not available' }));
        }
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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ videos }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to fetch videos: ' + err.message }));
        }
        return;
      }

      if (req.url === '/api/play' && req.method === 'POST') {
        if (!checkAuth(req, res)) return;
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

      try {
        let filePath = req.url === '/' ? '/index.html' : req.url;
        // Basic security to prevent directory traversal
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

    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`Dashboard running on http://0.0.0.0:${PORT}`);
    });

    server.on('error', (err) => {
      logger.warn('Dashboard failed to start:', err.message);
    });
  } catch (err) {
    logger.warn('Dashboard error:', err.message);
  }
}