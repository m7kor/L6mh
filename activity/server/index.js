/**
 * activity/server/index.js — Discord Activity backend.
 *
 * Responsibilities:
 *   1. Serve the built client (activity/client/dist)
 *   2. OAuth2 token exchange (POST /api/token)
 *   3. WebSocket relay: poll bot's /api/activity/state every 2s, broadcast to clients
 *   4. Jingle event relay: forward jingle events to connected clients
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.ACTIVITY_PORT) || 3334;
const HOST = process.env.ACTIVITY_HOST || '127.0.0.1';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const BOT_API_URL = process.env.BOT_API_URL || 'http://127.0.0.1:3333';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('[activity] CLIENT_ID and CLIENT_SECRET are required in .env');
  process.exit(1);
}

// ── Express + HTTP ──────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Serve built client
const clientDist = join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

// OAuth2 token exchange — POST /api/token
// Receives { code } from the Discord Embedded App SDK client,
// exchanges it for an access_token via Discord's OAuth2 token endpoint.
app.post('/api/token', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  try {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    });

    const discordRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!discordRes.ok) {
      const body = await discordRes.text();
      console.error('[activity] OAuth token exchange failed:', discordRes.status, body);
      return res.status(discordRes.status).json({ error: 'Token exchange failed' });
    }

    const data = await discordRes.json();
    res.json({
      access_token: data.access_token,
      token_type: data.token_type,
      expires_in: data.expires_in,
      scope: data.scope,
    });
  } catch (err) {
    console.error('[activity] OAuth error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(join(clientDist, 'index.html'));
});

// ── HTTP Server + WebSocket ─────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// State polling
let lastPollTime = 0;
let lastState = null;
let lastJingles = [];
const POLL_INTERVAL_MS = 2000;

async function pollBotState() {
  try {
    const url = `${BOT_API_URL}/api/activity/state?since=${lastPollTime}`;
    const headers = {};
    if (DASHBOARD_TOKEN) {
      headers['Authorization'] = `Bearer ${DASHBOARD_TOKEN}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;

    const data = await res.json();
    lastState = data.state;
    lastJingles = data.jingles || [];
    lastPollTime = data.timestamp || Date.now();

    // Broadcast to all connected WebSocket clients
    const message = JSON.stringify({
      type: 'state',
      state: lastState,
      jingles: lastJingles,
      timestamp: lastPollTime,
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(message); } catch {}
      }
    }
  } catch (err) {
    // Silently ignore poll errors — clients will get stale state
  }
}

// Poll every 2 seconds
const pollTimer = setInterval(pollBotState, POLL_INTERVAL_MS);

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('[activity] Client connected');

  // Send current state immediately
  if (lastState || lastJingles.length > 0) {
    try {
      ws.send(JSON.stringify({
        type: 'state',
        state: lastState,
        jingles: lastJingles,
        timestamp: lastPollTime,
      }));
    } catch {}
  }

  ws.on('close', () => {
    console.log('[activity] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[activity] WebSocket error:', err.message);
  });
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown() {
  console.log('[activity] Shutting down...');
  clearInterval(pollTimer);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`[activity] Server running on http://${HOST}:${PORT}`);
  console.log(`[activity] WebSocket: ws://${HOST}:${PORT}/ws`);
  console.log(`[activity] Bot API: ${BOT_API_URL}`);
});
