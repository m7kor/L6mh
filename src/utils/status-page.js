/**
 * Minimal read-only HTML status page.
 *
 * Served on a local HTTP server when STATUS_PORT is set.
 * Shows current track per guild, uptime, quota state, play counts.
 * No auth -- assumes reverse proxy if exposed. Won't affect core
 * bot functionality if the HTTP server fails to start.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('status');

const PORT = Number(process.env.STATUS_PORT) || 0;
const PLAYS_FILE = join(process.cwd(), 'play-counts.json');
const HEARTBEAT_FILE = join(process.cwd(), 'heartbeat.json');

let getSessionInfo = null;

function loadPlays() {
  if (!existsSync(PLAYS_FILE)) return {};
  try { return JSON.parse(readFileSync(PLAYS_FILE, 'utf-8')); } catch { return {}; }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? d + 'd ' + h + 'h ' + m + 'm' : h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPage() {
  var uptime = formatUptime(process.uptime() * 1000);

  var sessionRows = '';
  if (getSessionInfo) {
    var info = getSessionInfo(process.env.DISCORD_GUILD_ID || '');
    if (info && info.current) {
      sessionRows = '<tr>'
        + '<td>' + escapeHtml(info.current.title || '-') + '</td>'
        + '<td>' + escapeHtml(info.mode || '-') + '</td>'
        + '<td>' + (info.paused ? 'Paused' : 'Playing') + '</td>'
        + '<td>' + info.volume + '%</td>'
        + '<td>' + (info.connected ? 'Online' : 'Offline') + '</td>'
        + '</tr>';
    }
  }

  var plays = loadPlays();
  var sorted = Object.entries(plays)
    .sort(function(a, b) { return (b[1].count || 0) - (a[1].count || 0); })
    .slice(0, 10);
  var playRows = sorted.map(function(entry) {
    var id = entry[0];
    var v = entry[1];
    return '<tr>'
      + '<td>' + escapeHtml(v.title || id) + '</td>'
      + '<td>' + (v.count || 0) + '</td>'
      + '<td>' + (v.lastPlayedAt ? new Date(v.lastPlayedAt).toLocaleDateString() : '-') + '</td>'
      + '</tr>';
  }).join('');

  var rows = sessionRows || '<tr><td colspan="5">No active playback</td></tr>';
  var pRows = playRows || '<tr><td colspan="3">No data</td></tr>';

  return '<!DOCTYPE html>'
    + '<html lang="ar">'
    + '<head>'
    + '<meta charset="utf-8">'
    + '<title>Waheedomar Radio - Status</title>'
    + '<style>'
    + 'body { font-family: system-ui; background: #1a1a2e; color: #e0e0e0; padding: 2rem; }'
    + 'h1 { color: #d4af37; }'
    + 'table { border-collapse: collapse; width: 100%; margin: 1rem 0; }'
    + 'th, td { padding: 8px 12px; border: 1px solid #333; text-align: right; }'
    + 'th { background: #16213e; }'
    + '</style>'
    + '</head>'
    + '<body>'
    + '<h1>Waheedomar Radio</h1>'
    + '<p>Uptime: <strong>' + uptime + '</strong> | PID: ' + process.pid + '</p>'
    + '<h2>Current Playback</h2>'
    + '<table>'
    + '<tr><th>Track</th><th>Mode</th><th>Status</th><th>Volume</th><th>Connection</th></tr>'
    + rows
    + '</table>'
    + '<h2>Most Played</h2>'
    + '<table>'
    + '<tr><th>Track</th><th>Plays</th><th>Last Played</th></tr>'
    + pRows
    + '</table>'
    + '</body>'
    + '</html>';
}

export function startStatusPage(getSessionInfoFn) {
  if (!PORT) return;
  getSessionInfo = getSessionInfoFn;

  try {
    var server = createServer(function(req, res) {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildPage());
    });

    server.listen(PORT, '0.0.0.0', function() {
      logger.info('Status page running on http://0.0.0.0:' + PORT);
    });

    server.on('error', function(err) {
      logger.warn('Status page failed to start:', err.message);
    });
  } catch (err) {
    logger.warn('Status page error:', err.message);
  }
}
