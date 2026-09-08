/**
 * Dashboard — full HTML status page with live API.
 *
 * Served on STATUS_PORT (default off). Shows real-time bot status,
 * current track, guilds, uptime, play counts. Terminal sends commands
 * to the bot via internal API. No auth — reverse proxy recommended.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('dashboard');

const PORT = Number(process.env.STATUS_PORT) || 0;
const PLAYS_FILE = join(process.cwd(), 'play-counts.json');

let getSessionInfo = null;
let getAllSessions = null;
let executeCommand = null;

function loadPlays() {
  if (!existsSync(PLAYS_FILE)) return {};
  try { return JSON.parse(readFileSync(PLAYS_FILE, 'utf-8')); } catch { return {}; }
}

function getApiData() {
  const plays = loadPlays();
  const sorted = Object.entries(plays)
    .sort(function(a, b) { return (b[1].count || 0) - (a[1].count || 0); })
    .slice(0, 10);

  let sessions = [];
  if (getAllSessions) {
    sessions = getAllSessions();
  }

  return {
    uptime: process.uptime(),
    pid: process.pid,
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    guilds: sessions.length,
    sessions: sessions,
    topPlayed: sorted.map(function(entry) {
      return { id: entry[0], title: entry[1].title, count: entry[1].count, lastPlayedAt: entry[1].lastPlayedAt };
    }),
    timestamp: new Date().toISOString(),
  };
}

function buildDashboard() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Waheed Omar | Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --bg-main: #060608;
            --bg-elevated: #0c0c11;
            --card-bg: rgba(255, 255, 255, 0.025);
            --card-border: rgba(255, 255, 255, 0.06);
            --card-hover-border: rgba(255, 255, 255, 0.12);
            --neon-blue: #00f3ff;
            --neon-purple: #bc13fe;
            --neon-green: #00ff9d;
            --neon-red: #ff0055;
            --neon-orange: #ff9f1c;
            --text-main: #ffffff;
            --text-muted: #7a7a85;
            --gap: 14px;
            --rad-lg: 20px;
            --rad-md: 14px;
            --rad-sm: 10px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Tajawal', 'Outfit', sans-serif; }

        body {
            background: var(--bg-main);
            color: var(--text-main);
            height: 100vh;
            overflow: hidden;
            display: flex;
            position: relative;
        }

        body::before {
            content: '';
            position: fixed;
            width: 100%; height: 100%;
            background-image: radial-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px);
            background-size: 32px 32px;
            z-index: 0;
            pointer-events: none;
        }

        .glow-orb { position: fixed; border-radius: 50%; filter: blur(140px); z-index: 0; pointer-events: none; }
        .orb-1 { top: -15%; right: -5%; width: 500px; height: 500px; background: var(--neon-purple); opacity: 0.1; }
        .orb-2 { bottom: -15%; left: -5%; width: 600px; height: 600px; background: var(--neon-blue); opacity: 0.08; }
        .orb-3 { top: 50%; left: 50%; width: 400px; height: 400px; background: var(--neon-green); opacity: 0.03; transform: translate(-50%, -50%); }

        /* ===== SIDEBAR ===== */
        .sidebar {
            width: 64px;
            background: var(--bg-elevated);
            border-left: 1px solid var(--card-border);
            padding: 20px 0;
            display: flex; flex-direction: column; align-items: center; gap: 24px;
            position: relative; z-index: 10;
            flex-shrink: 0;
        }
        .sidebar-logo {
            width: 38px; height: 38px; border-radius: var(--rad-sm);
            background: linear-gradient(135deg, var(--neon-blue), var(--neon-purple));
            display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px; color: #000;
            box-shadow: 0 0 20px rgba(0, 243, 255, 0.25);
        }
        .nav-items { display: flex; flex-direction: column; gap: 8px; flex: 1; }
        .nav-icon {
            width: 38px; height: 38px; border-radius: var(--rad-sm);
            display: flex; align-items: center; justify-content: center;
            color: var(--text-muted); cursor: pointer; transition: 0.3s; font-size: 14px;
            border: 1px solid transparent; position: relative;
        }
        .nav-icon:hover { color: #fff; background: rgba(255,255,255,0.04); }
        .nav-icon.active { color: var(--neon-blue); background: rgba(0, 243, 255, 0.08); border-color: rgba(0, 243, 255, 0.15); }
        .nav-icon::after {
            content: attr(data-name);
            position: absolute; right: 48px;
            background: #111; color: #fff; padding: 5px 10px; border-radius: 6px;
            font-size: 11px; white-space: nowrap; opacity: 0; transform: translateX(10px);
            transition: 0.2s; pointer-events: none; border: 1px solid var(--card-border); z-index: 100;
        }
        .nav-icon:hover::after { opacity: 1; transform: translateX(0); }
        .yt-sidebar { color: var(--text-muted); font-size: 16px; transition: 0.3s; }
        .yt-sidebar:hover { color: #ff0000; transform: scale(1.1); }

        /* ===== MAIN WRAPPER ===== */
        .main-wrapper {
            flex: 1; padding: 20px; position: relative; z-index: 1;
            display: flex; flex-direction: column; overflow: hidden;
            min-width: 0;
        }

        /* ===== HEADER ===== */
        .header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 18px; flex-shrink: 0;
        }
        .header-left { display: flex; align-items: center; gap: 16px; }
        .header-left h1 {
            font-size: 22px; font-weight: 900; letter-spacing: -0.5px;
            display: flex; align-items: center; gap: 12px;
        }
        .header-left h1 span {
            background: linear-gradient(90deg, var(--neon-blue), var(--neon-purple));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .header-left p { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
        .status-pill {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 5px 12px; background: rgba(0, 255, 157, 0.08); border: 1px solid rgba(0, 255, 157, 0.15);
            border-radius: 20px; font-size: 10px; color: var(--neon-green); font-weight: 700;
        }
        .status-dot {
            width: 6px; height: 6px; background: var(--neon-green); border-radius: 50%;
            box-shadow: 0 0 8px var(--neon-green); animation: pulse 2s infinite;
        }
        @keyframes pulse { 50% { opacity: 0.4; } }

        /* ===== GRID ===== */
        .grid-layout {
            display: grid;
            grid-template-columns: 200px 1fr 1fr 320px;
            grid-template-rows: 1fr;
            gap: var(--gap);
            flex: 1; min-height: 0;
        }

        /* ===== CARD BASE ===== */
        .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: var(--rad-lg);
            padding: 18px;
            position: relative; overflow: hidden;
            transition: border-color 0.3s ease, background 0.3s ease;
            backdrop-filter: blur(16px) saturate(180%);
            box-shadow: 0 4px 16px rgba(0,0,0,0.2);
            display: flex; flex-direction: column;
        }
        .card::before {
            content: ''; position: absolute; inset: 0;
            background: radial-gradient(400px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(255, 255, 255, 0.04), transparent 40%);
            opacity: 0; transition: opacity 0.3s; pointer-events: none;
        }
        .card:hover::before { opacity: 1; }
        .card:hover { border-color: var(--card-hover-border); }

        .card-title {
            font-size: 11px; font-weight: 700; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px;
            display: flex; align-items: center; gap: 8px;
        }
        .card-title i { font-size: 12px; color: var(--neon-blue); }

        /* ===== COL 1: STATUS SIDEBAR (right in RTL) ===== */
        .col-status {
            display: flex; flex-direction: column; gap: var(--gap);
        }

        .gauge-card { align-items: center; justify-content: center; text-align: center; padding: 20px 12px; }
        .gauge-ring {
            width: 90px; height: 90px; border-radius: 50%;
            background: conic-gradient(from 140deg, var(--neon-blue) 0%, var(--neon-purple) 75%, rgba(255,255,255,0.05) 75%);
            display: flex; align-items: center; justify-content: center;
            position: relative; margin-bottom: 12px;
        }
        .gauge-inner {
            width: 74px; height: 74px; background: var(--bg-elevated); border-radius: 50%;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
        }
        .gauge-value { font-size: 20px; font-weight: 800; color: #fff; }
        .gauge-label { font-size: 7px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
        .gauge-stats { margin-top: 8px; }
        .gauge-stats div { font-size: 22px; font-weight: 800; color: var(--neon-blue); }
        .gauge-stats span { font-size: 10px; color: var(--text-muted); display: block; margin-top: 1px; }

        .top-tracks-card { flex: 1; overflow: hidden; }
        .top-tracks-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
        .track-item {
            display: flex; align-items: center; gap: 10px; padding: 8px 10px;
            background: rgba(0,0,0,0.2); border-radius: var(--rad-sm); border: 1px solid var(--card-border);
            transition: 0.2s;
        }
        .track-item:hover { border-color: var(--neon-blue); background: rgba(0, 243, 255, 0.03); }
        .track-rank {
            width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
            font-size: 10px; font-weight: 800; flex-shrink: 0;
            background: rgba(255,255,255,0.04); color: var(--text-muted);
        }
        .track-item:nth-child(1) .track-rank { background: rgba(255, 215, 0, 0.12); color: #ffd700; }
        .track-item:nth-child(2) .track-rank { background: rgba(192, 192, 192, 0.12); color: #c0c0c0; }
        .track-item:nth-child(3) .track-rank { background: rgba(205, 127, 50, 0.12); color: #cd7f32; }
        .track-info { flex: 1; min-width: 0; }
        .track-info p { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .track-info span { font-size: 9px; color: var(--text-muted); }
        .track-plays { font-size: 10px; font-weight: 700; color: var(--neon-purple); flex-shrink: 0; }

        /* ===== COL 2-3: MAIN CONTENT ===== */
        .col-main {
            display: flex; flex-direction: column; gap: var(--gap);
            grid-column: 2 / 4;
        }

        .now-playing-card {
            padding: 24px; flex-shrink: 0;
        }
        .np-inner { display: flex; align-items: center; gap: 20px; }
        .np-thumb {
            width: 90px; height: 90px; border-radius: var(--rad-md); overflow: hidden;
            flex-shrink: 0; position: relative;
            border: 2px solid var(--card-border);
        }
        .np-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .np-thumb::after {
            content: ''; position: absolute; inset: 0;
            background: linear-gradient(135deg, rgba(0, 243, 255, 0.1), rgba(188, 19, 254, 0.1));
            opacity: 0; transition: 0.3s;
        }
        .np-thumb:hover::after { opacity: 1; }
        .np-info { flex: 1; min-width: 0; }
        .np-title {
            font-size: 20px; font-weight: 900; line-height: 1.2; margin-bottom: 6px;
            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        .np-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .np-badge {
            display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
            border-radius: 20px; font-size: 10px; font-weight: 600;
        }
        .np-badge.mode { background: rgba(0, 243, 255, 0.1); color: var(--neon-blue); border: 1px solid rgba(0, 243, 255, 0.15); }
        .np-badge.vol { background: rgba(0, 255, 157, 0.1); color: var(--neon-green); border: 1px solid rgba(0, 255, 157, 0.15); }
        .np-badge.views { background: rgba(188, 19, 254, 0.1); color: var(--neon-purple); border: 1px solid rgba(188, 19, 254, 0.15); }
        .np-badge.guild { background: rgba(255, 159, 28, 0.1); color: var(--neon-orange); border: 1px solid rgba(255, 159, 28, 0.15); }
        .np-progress { margin-top: 14px; }
        .progress-bar {
            width: 100%; height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden;
        }
        .progress-fill {
            height: 100%; background: linear-gradient(90deg, var(--neon-blue), var(--neon-purple));
            border-radius: 2px; transition: width 1s linear;
        }
        .np-visualizer {
            display: flex; gap: 3px; height: 32px; align-items: flex-end; flex-shrink: 0;
        }
        .v-bar {
            width: 4px; border-radius: 2px;
            background: linear-gradient(180deg, var(--neon-green), rgba(0, 255, 157, 0.15));
            box-shadow: 0 0 6px rgba(0, 255, 157, 0.4);
            animation: wave 1.2s infinite ease-in-out;
        }
        @keyframes wave { 0%, 100% { height: 6px; } 50% { height: 28px; } }

        .middle-row {
            display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap);
            flex: 1; min-height: 0;
        }

        /* Voice Connection */
        .voice-card { align-items: center; justify-content: center; text-align: center; }
        .voice-visual {
            width: 80px; height: 80px; border-radius: 50%;
            background: rgba(0, 255, 157, 0.06); border: 2px solid rgba(0, 255, 157, 0.2);
            display: flex; align-items: center; justify-content: center;
            position: relative; margin-bottom: 14px;
        }
        .voice-visual i { font-size: 28px; color: var(--neon-green); }
        .voice-visual::before, .voice-visual::after {
            content: ''; position: absolute; width: 100%; height: 100%;
            border: 1px solid var(--neon-green); border-radius: 50%; opacity: 0;
        }
        .voice-visual.active::before { animation: ripple 2s infinite; }
        .voice-visual.active::after { animation: ripple 2s infinite 1s; }
        @keyframes ripple { 0% { transform: scale(0.85); opacity: 0.7; } 100% { transform: scale(1.4); opacity: 0; } }

        .voice-info h4 { font-size: 15px; font-weight: 700; margin-bottom: 3px; }
        .voice-info span { font-size: 11px; font-weight: 600; }
        .voice-info .connected { color: var(--neon-green); }
        .voice-info .disconnected { color: var(--neon-red); }
        .voice-stats { display: flex; gap: 24px; margin-top: 14px; }
        .vstat { text-align: center; }
        .vstat div { font-size: 16px; font-weight: 800; color: var(--text-main); }
        .vstat span { font-size: 9px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .voice-btns { display: flex; gap: 8px; margin-top: 14px; }
        .vbtn {
            padding: 7px 14px; border-radius: var(--rad-sm); background: rgba(255,255,255,0.04);
            border: 1px solid var(--card-border); color: #fff; cursor: pointer;
            transition: 0.2s; font-size: 11px; font-weight: 600; font-family: inherit;
            display: flex; align-items: center; gap: 5px;
        }
        .vbtn:hover { border-color: var(--neon-blue); background: rgba(0, 243, 255, 0.06); }
        .vbtn:active { transform: scale(0.96); }
        .vbtn i { font-size: 11px; }

        /* Quick Actions */
        .quick-card .qbtns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex: 1; }
        .qbtn {
            background: rgba(255,255,255,0.02); border: 1px solid var(--card-border);
            border-radius: var(--rad-sm); padding: 12px 10px; color: #fff; cursor: pointer;
            transition: 0.2s; display: flex; align-items: center; justify-content: center; gap: 6px;
            font-size: 11px; font-weight: 600; font-family: inherit;
        }
        .qbtn:hover { border-color: var(--neon-blue); background: rgba(0, 243, 255, 0.04); }
        .qbtn:active { transform: scale(0.96); }
        .qbtn i { font-size: 13px; color: var(--neon-blue); }

        /* ===== COL 4: TERMINAL (left in RTL) ===== */
        .col-terminal {
            display: flex; flex-direction: column;
        }

        .terminal-card { flex: 1; padding: 0; }
        .terminal-header {
            padding: 10px 14px; border-bottom: 1px solid var(--card-border);
            display: flex; align-items: center; gap: 10px;
            background: rgba(0,0,0,0.25); flex-shrink: 0;
        }
        .dots { display: flex; gap: 4px; }
        .dot { width: 7px; height: 7px; border-radius: 50%; }
        .dot.red { background: #ff5f56; } .dot.yellow { background: #ffbd2e; } .dot.green { background: #27c93f; }
        .terminal-title { font-size: 10px; color: var(--text-muted); }
        .terminal-body {
            flex: 1; padding: 12px; overflow-y: auto;
            font-family: 'Outfit', monospace; font-size: 12px; line-height: 1.5;
            display: flex; flex-direction: column; gap: 8px;
        }
        .terminal-msg { display: flex; gap: 6px; }
        .terminal-msg .prompt { color: var(--neon-blue); font-weight: 700; flex-shrink: 0; }
        .terminal-msg .text { color: #d1d1d1; word-break: break-word; }
        .terminal-msg.user .prompt { color: var(--neon-purple); }
        .terminal-input-area {
            padding: 10px 14px; border-top: 1px solid var(--card-border);
            display: flex; align-items: center; gap: 8px;
            background: rgba(0,0,0,0.25); flex-shrink: 0;
        }
        .terminal-input {
            flex: 1; background: transparent; border: none; outline: none;
            color: #fff; font-family: 'Outfit', monospace; font-size: 12px;
        }
        .terminal-input::placeholder { color: #444; }
        .terminal-send {
            width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--card-border);
            background: rgba(0, 243, 255, 0.08); color: var(--neon-blue); cursor: pointer;
            display: flex; align-items: center; justify-content: center; font-size: 11px;
            transition: 0.2s;
        }
        .terminal-send:hover { background: rgba(0, 243, 255, 0.15); }

        /* ===== SCROLLBAR ===== */
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }

        /* ===== RESPONSIVE ===== */
        @media (max-width: 1200px) {
            .grid-layout { grid-template-columns: 180px 1fr 280px; }
            .col-main { grid-column: 2; }
            .col-terminal { grid-column: 3; }
        }
        @media (max-width: 900px) {
            body { overflow-y: auto; height: auto; }
            .grid-layout { grid-template-columns: 1fr; grid-template-rows: auto; }
            .col-main, .col-terminal { grid-column: 1; }
            .middle-row { grid-template-columns: 1fr; }
            .sidebar { display: none; }
        }
    </style>
</head>
<body>
    <div class="glow-orb orb-1"></div>
    <div class="glow-orb orb-2"></div>
    <div class="glow-orb orb-3"></div>

    <aside class="sidebar">
        <div class="sidebar-logo">W</div>
        <nav class="nav-items">
            <div class="nav-icon active" data-name="Home"><i class="fas fa-th-large"></i></div>
            <div class="nav-icon" data-name="Commands"><i class="fas fa-terminal"></i></div>
            <div class="nav-icon" data-name="Stats"><i class="fas fa-chart-line"></i></div>
            <div class="nav-icon" data-name="Settings"><i class="fas fa-cog"></i></div>
        </nav>
        <a href="https://www.youtube.com/@Waheedomar" target="_blank" class="nav-icon yt-sidebar" data-name="YouTube"><i class="fab fa-youtube"></i></a>
    </aside>

    <main class="main-wrapper">
        <header class="header">
            <div class="header-left">
                <div>
                    <h1>Waheedomar <span>Radio</span></h1>
                    <p>Bot Dashboard &mdash; Live Monitoring</p>
                </div>
            </div>
            <div class="status-pill"><div class="status-dot" id="statusDot"></div> <span id="statusText">Loading...</span></div>
        </header>

        <div class="grid-layout">
            <!-- RIGHT COL: Status + Top Tracks -->
            <div class="col-status">
                <div class="card gauge-card">
                    <div class="gauge-ring">
                        <div class="gauge-inner">
                            <div class="gauge-value" id="uptimeValue">--</div>
                            <div class="gauge-label">Uptime</div>
                        </div>
                    </div>
                    <div class="gauge-stats">
                        <div id="guildCount">--</div>
                        <span>Servers</span>
                    </div>
                </div>
                <div class="card top-tracks-card">
                    <div class="card-title"><i class="fas fa-fire"></i> Top Played</div>
                    <div class="top-tracks-list" id="topTracks">
                        <div style="text-align:center;color:var(--text-muted);padding:20px;font-size:11px;">Loading...</div>
                    </div>
                </div>
            </div>

            <!-- MIDDLE: Now Playing + Voice + Quick -->
            <div class="col-main">
                <div class="card now-playing-card">
                    <div class="card-title"><i class="fas fa-music"></i> Now Playing</div>
                    <div class="np-inner">
                        <div class="np-thumb">
                            <img id="npThumb" src="" alt="" onerror="this.style.display='none'">
                        </div>
                        <div class="np-info">
                            <div class="np-title" id="npTitle">Loading...</div>
                            <div class="np-meta">
                                <span class="np-badge mode" id="npMode"><i class="fas fa-play"></i> --</span>
                                <span class="np-badge vol" id="npVol"><i class="fas fa-volume-up"></i> --%</span>
                                <span class="np-badge views" id="npViews"><i class="fas fa-eye"></i> --</span>
                                <span class="np-badge guild" id="npGuild"><i class="fas fa-server"></i> --</span>
                            </div>
                            <div class="np-progress">
                                <div class="progress-bar"><div class="progress-fill" id="npProgress" style="width:0%"></div></div>
                            </div>
                        </div>
                        <div class="np-visualizer">
                            <div class="v-bar" style="animation-delay:0.1s"></div>
                            <div class="v-bar" style="animation-delay:0.3s"></div>
                            <div class="v-bar" style="animation-delay:0.5s"></div>
                            <div class="v-bar" style="animation-delay:0.2s"></div>
                            <div class="v-bar" style="animation-delay:0.4s"></div>
                        </div>
                    </div>
                </div>

                <div class="middle-row">
                    <div class="card voice-card">
                        <div class="card-title"><i class="fas fa-headphones"></i> Voice</div>
                        <div class="voice-visual active"><i class="fas fa-microphone"></i></div>
                        <div class="voice-info">
                            <h4 id="voiceGuild">--</h4>
                            <span id="voiceStatus" class="connected">--</span>
                        </div>
                        <div class="voice-stats">
                            <div class="vstat"><div id="memValue">--</div><span>Memory</span></div>
                            <div class="vstat"><div id="pidValue">--</div><span>PID</span></div>
                            <div class="vstat"><div id="queueValue">0</div><span>Queue</span></div>
                        </div>
                        <div class="voice-btns">
                            <button class="vbtn" onclick="sendCmd('/عشوائي')"><i class="fas fa-play"></i> Random</button>
                            <button class="vbtn" onclick="sendCmd('/كمل')"><i class="fas fa-redo"></i> Resume</button>
                            <button class="vbtn" onclick="sendCmd('/اخر_مقطع')"><i class="fas fa-forward"></i> Latest</button>
                        </div>
                    </div>

                    <div class="card quick-card">
                        <div class="card-title"><i class="fas fa-bolt"></i> Quick Actions</div>
                        <div class="qbtns">
                            <button class="qbtn" onclick="sendCmd('skip')"><i class="fas fa-forward"></i> Skip</button>
                            <button class="qbtn" onclick="sendCmd('np')"><i class="fas fa-info-circle"></i> Now Playing</button>
                            <button class="qbtn" onclick="sendCmd('queue')"><i class="fas fa-list"></i> Queue</button>
                            <button class="qbtn" onclick="sendCmd('status')"><i class="fas fa-chart-bar"></i> Status</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- LEFT COL: Terminal -->
            <div class="col-terminal">
                <div class="card terminal-card">
                    <div class="terminal-header">
                        <div class="dots"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div></div>
                        <span class="terminal-title">Bot Terminal</span>
                    </div>
                    <div class="terminal-body" id="terminalBody">
                        <div class="terminal-msg"><span class="prompt">System:</span><span class="text">Type /help for commands.</span></div>
                    </div>
                    <div class="terminal-input-area">
                        <input type="text" class="terminal-input" id="cmdInput" placeholder="Type command..." autofocus>
                        <button class="terminal-send" onclick="submitCmd()"><i class="fas fa-chevron-left"></i></button>
                    </div>
                </div>
            </div>
        </div>
    </main>

    <script>
        const terminalBody = document.getElementById('terminalBody');
        const cmdInput = document.getElementById('cmdInput');
        let cmdHistory = [];
        let cmdIndex = -1;

        function addTerminalMsg(prompt, text, type) {
            const msg = document.createElement('div');
            msg.className = 'terminal-msg ' + (type || '');
            msg.innerHTML = '<span class="prompt">' + prompt + '</span><span class="text">' + text + '</span>';
            terminalBody.appendChild(msg);
            terminalBody.scrollTop = terminalBody.scrollHeight;
            if (terminalBody.children.length > 50) terminalBody.removeChild(terminalBody.firstChild);
        }

        function submitCmd() {
            if (cmdInput.value.trim()) {
                cmdHistory.push(cmdInput.value.trim());
                cmdIndex = cmdHistory.length;
                sendCmd(cmdInput.value.trim());
                cmdInput.value = '';
            }
        }

        async function sendCmd(cmd) {
            addTerminalMsg('Admin>', cmd, 'user');
            try {
                const res = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) });
                const data = await res.json();
                addTerminalMsg('Bot>', data.reply || data.error || 'Done.');
            } catch (e) {
                addTerminalMsg('Error>', e.message);
            }
        }

        cmdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { submitCmd(); }
            else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (cmdIndex > 0) { cmdIndex--; cmdInput.value = cmdHistory[cmdIndex]; }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (cmdIndex < cmdHistory.length - 1) { cmdIndex++; cmdInput.value = cmdHistory[cmdIndex]; }
                else { cmdIndex = cmdHistory.length; cmdInput.value = ''; }
            }
        });

        async function refreshData() {
            try {
                const res = await fetch('/api/status');
                const d = await res.json();

                document.getElementById('statusDot').style.background = 'var(--neon-green)';
                document.getElementById('statusText').textContent = 'Bot Online';

                document.getElementById('uptimeValue').textContent = fmt(d.uptime);
                document.getElementById('guildCount').textContent = d.guilds;
                document.getElementById('memValue').textContent = d.memMB + 'MB';
                document.getElementById('pidValue').textContent = d.pid;

                if (d.sessions.length > 0) {
                    const s = d.sessions[0];
                    document.getElementById('npTitle').textContent = s.title || 'No Track';
                    document.getElementById('npThumb').src = s.thumbnail || '';
                    document.getElementById('npMode').innerHTML = '<i class="fas fa-play"></i> ' + (s.mode || '--');
                    document.getElementById('npVol').innerHTML = '<i class="fas fa-volume-up"></i> ' + (s.volume || 0) + '%';
                    document.getElementById('npGuild').innerHTML = '<i class="fas fa-server"></i> ' + (s.guildName || '--');
                    document.getElementById('queueValue').textContent = s.queueCount || 0;

                    document.getElementById('voiceGuild').textContent = s.guildName || '--';
                    var vs = document.getElementById('voiceStatus');
                    vs.textContent = s.connected ? 'Connected' : 'Disconnected';
                    vs.className = s.connected ? 'connected' : 'disconnected';
                }

                if (d.topPlayed.length > 0) {
                    var html = '';
                    d.topPlayed.forEach(function(t, i) {
                        html += '<div class="track-item">'
                            + '<div class="track-rank">' + (i + 1) + '</div>'
                            + '<div class="track-info"><p>' + esc(t.title || t.id) + '</p><span>' + (t.count || 0) + ' plays</span></div>'
                            + '</div>';
                    });
                    document.getElementById('topTracks').innerHTML = html;
                }
            } catch (e) {
                document.getElementById('statusText').textContent = 'Offline';
                document.getElementById('statusDot').style.background = 'var(--neon-red)';
            }
        }

        function fmt(s) {
            var d = Math.floor(s / 86400);
            var h = Math.floor((s % 86400) / 3600);
            var m = Math.floor((s % 3600) / 60);
            return d > 0 ? d + 'd ' + h + 'h' : h > 0 ? h + 'h ' + m + 'm' : m + 'm';
        }

        function esc(s) {
            var div = document.createElement('div');
            div.textContent = s;
            return div.innerHTML;
        }

        document.querySelectorAll('.card').forEach(function(card) {
            card.addEventListener('mousemove', function(e) {
                var rect = card.getBoundingClientRect();
                card.style.setProperty('--mouse-x', (e.clientX - rect.left) + 'px');
                card.style.setProperty('--mouse-y', (e.clientY - rect.top) + 'px');
            });
        });

        refreshData();
        setInterval(refreshData, 5000);
    </script>
</body>
</html>`;
}

export function startStatusPage(getSessionInfoFn, getAllSessionsFn, executeCommandFn) {
  if (!PORT) return;
  getSessionInfo = getSessionInfoFn;
  getAllSessions = getAllSessionsFn || null;
  executeCommand = executeCommandFn || null;

  try {
    var server = createServer(function(req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
        return;
      }

      if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getApiData()));
        return;
      }

      if (req.url === '/api/command' && req.method === 'POST') {
        var body = '';
        req.on('data', function(chunk) { body += chunk; });
        req.on('end', function() {
          try {
            var parsed = JSON.parse(body);
            var cmd = (parsed.command || '').trim();
            if (!cmd) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No command provided' }));
              return;
            }
            if (executeCommand) {
              var reply = executeCommand(cmd);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, reply: reply || 'Command executed.' }));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, reply: 'Command received: ' + cmd }));
            }
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildDashboard());
    });

    server.listen(PORT, '0.0.0.0', function() {
      logger.info('Dashboard running on http://0.0.0.0:' + PORT);
    });

    server.on('error', function(err) {
      logger.warn('Dashboard failed to start:', err.message);
    });
  } catch (err) {
    logger.warn('Dashboard error:', err.message);
  }
}
