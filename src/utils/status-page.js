/**
 * Dashboard — full HTML status page with live API.
 * New Layout: Workspace / Command Center Style.
 */

import { createServer } from 'node:http';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { loadPlays } from './stats.js';

const logger = createLogger('dashboard');

const PORT = Number(process.env.STATUS_PORT) || 0;

let getSessionInfo = null;
let getAllSessions = null;
let executeCommand = null;

let cachedHtml = null;

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
  if (getAllSessions) {
    sessions = getAllSessions().map(session => ({
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
    timestamp: new Date().toISOString(),
  };
}

export function startStatusPage(getSessionInfoFn, getAllSessionsFn, executeCommandFn) {
  if (!PORT) return;
  getSessionInfo = getSessionInfoFn;
  getAllSessions = getAllSessionsFn || null;
  executeCommand = executeCommandFn || null;

  try {
    const server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
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
            
            if (executeCommand) {
              try {
                const reply = await Promise.resolve(executeCommand(cmd));
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
        if (executeCommand) {
          try {
            await Promise.resolve(executeCommand('skip'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'executeCommand not available' }));
        }
        return;
      }

      if (req.url === '/api/volume' && req.method === 'POST') {
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
            if (executeCommand) {
              await Promise.resolve(executeCommand('volume ' + parsed.volume));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'executeCommand not available' }));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
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