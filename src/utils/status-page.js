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
            --text-main: #ffffff;
            --text-muted: #7a7a85;
            --gap: 16px;
            --rad-lg: 24px;
            --rad-md: 16px;
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

        .sidebar {
            width: 72px;
            background: var(--bg-elevated);
            border-left: 1px solid var(--card-border);
            padding: 24px 0;
            display: flex; flex-direction: column; align-items: center; gap: 30px;
            position: relative; z-index: 10;
        }
        .sidebar-logo {
            width: 42px; height: 42px; border-radius: var(--rad-md);
            background: linear-gradient(135deg, var(--neon-blue), var(--neon-purple));
            display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 20px; color: #000;
            box-shadow: 0 0 15px rgba(0, 243, 255, 0.2);
        }
        .nav-items { display: flex; flex-direction: column; gap: 15px; flex: 1; }
        .nav-icon {
            width: 42px; height: 42px; border-radius: var(--rad-sm);
            display: flex; align-items: center; justify-content: center;
            color: var(--text-muted); cursor: pointer; transition: 0.3s; font-size: 16px;
            border: 1px solid transparent; position: relative;
        }
        .nav-icon:hover { color: #fff; background: rgba(255,255,255,0.04); }
        .nav-icon.active { color: var(--neon-blue); background: rgba(0, 243, 255, 0.08); border-color: rgba(0, 243, 255, 0.15); }
        .nav-icon::after {
            content: attr(data-name);
            position: absolute; left: 52px;
            background: #000; color: #fff; padding: 6px 12px; border-radius: 6px;
            font-size: 12px; white-space: nowrap; opacity: 0; transform: translateX(-10px);
            transition: 0.2s; pointer-events: none; border: 1px solid var(--card-border); z-index: 100;
        }
        .nav-icon:hover::after { opacity: 1; transform: translateX(0); }
        .yt-sidebar { color: var(--text-muted); font-size: 18px; transition: 0.3s; }
        .yt-sidebar:hover { color: #ff0000; transform: scale(1.1); }

        .main-wrapper {
            flex: 1; padding: 24px; position: relative; z-index: 1;
            display: flex; flex-direction: column; overflow: hidden;
        }

        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-shrink: 0; }
        .header h1 { font-size: 28px; font-weight: 900; letter-spacing: -0.5px; display: flex; align-items: center; gap: 15px; }
        .header h1 span { background: linear-gradient(90deg, var(--neon-blue), var(--neon-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .header p { color: var(--text-muted); font-size: 13px; margin-top: 3px; }
        .header-right { display: flex; align-items: center; gap: 15px; }
        .status-pill {
            display: flex; align-items: center; gap: 8px;
            padding: 8px 16px; background: rgba(0, 255, 157, 0.08); border: 1px solid rgba(0, 255, 157, 0.15);
            border-radius: 30px; font-size: 11px; color: var(--neon-green); font-weight: 700;
        }
        .status-dot { width: 7px; height: 7px; background: var(--neon-green); border-radius: 50%; box-shadow: 0 0 10px var(--neon-green); animation: pulse 2s infinite; }
        @keyframes pulse { 50% { opacity: 0.4; } }

        .grid-layout {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            grid-template-rows: 130px 1fr 170px;
            grid-template-areas:
                "quote quote quote gauge"
                "terminal terminal connection activity"
                "terminal terminal quick activity";
            gap: var(--gap);
            flex: 1; min-height: 0;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: var(--rad-lg);
            padding: 20px;
            position: relative; overflow: hidden;
            transition: border-color 0.3s ease, background 0.3s ease;
            backdrop-filter: blur(16px) saturate(180%);
            box-shadow: 0 8px 20px rgba(0,0,0,0.3);
            display: flex; flex-direction: column;
        }
        .card::before {
            content: ''; position: absolute; inset: 0;
            background: radial-gradient(400px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(255, 255, 255, 0.04), transparent 40%);
            opacity: 0; transition: opacity 0.3s; pointer-events: none;
        }
        .card:hover::before { opacity: 1; }
        .card:hover { border-color: var(--card-hover-border); }

        .quote-card { grid-area: quote; flex-direction: row; align-items: center; justify-content: space-between; padding: 0 30px; }
        .gauge-card { grid-area: gauge; align-items: center; justify-content: center; text-align: center; }
        .terminal-card { grid-area: terminal; padding: 0; }
        .connection-card { grid-area: connection; align-items: center; justify-content: space-between; padding: 20px; }
        .quick-card { grid-area: quick; justify-content: center; }
        .activity-card { grid-area: activity; }

        .quote-content h2 {
            font-size: 32px; font-weight: 900; line-height: 1.1; letter-spacing: -1px;
            background: linear-gradient(90deg, #fff, #999);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .quote-content h2 span {
            display: block; font-size: 24px;
            background: linear-gradient(90deg, var(--neon-blue), var(--neon-purple));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .quote-content p { color: var(--text-muted); font-size: 12px; margin-top: 5px; }

        .visualizer-3d { display: flex; gap: 4px; height: 50px; align-items: flex-end; }
        .bar-3d {
            width: 5px; background: linear-gradient(180deg, var(--neon-green), rgba(0, 255, 157, 0.1));
            border-radius: 3px; box-shadow: 0 0 8px rgba(0, 255, 157, 0.5);
            animation: wave 1.2s infinite ease-in-out;
        }
        @keyframes wave { 0%, 100% { height: 10px; } 50% { height: 40px; } }

        .gauge-ring {
            width: 80px; height: 80px; border-radius: 50%;
            background: conic-gradient(from 140deg, var(--neon-blue) 0%, var(--neon-purple) 75%, rgba(255,255,255,0.05) 75%);
            display: flex; align-items: center; justify-content: center;
            position: relative; margin-bottom: 15px;
        }
        .gauge-inner {
            width: 66px; height: 66px; background: var(--bg-elevated); border-radius: 50%;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
        }
        .gauge-value { font-size: 18px; font-weight: 800; color: #fff; }
        .gauge-label { font-size: 8px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
        .gauge-stats div { font-size: 24px; font-weight: 800; color: var(--neon-blue); }
        .gauge-stats span { font-size: 11px; color: var(--text-muted); display: block; margin-top: 2px; }

        .terminal-header { padding: 12px 16px; border-bottom: 1px solid var(--card-border); display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,0.2); flex-shrink: 0; }
        .dots { display: flex; gap: 5px; }
        .dot { width: 7px; height: 7px; border-radius: 50%; }
        .dot.red { background: #ff5f56; } .dot.yellow { background: #ffbd2e; } .dot.green { background: #27c93f; }
        .terminal-title { font-size: 11px; color: var(--text-muted); }
        .terminal-body { flex: 1; padding: 16px; overflow-y: auto; font-family: 'Outfit', monospace; font-size: 13px; line-height: 1.5; }
        .terminal-msg { margin-bottom: 10px; display: flex; gap: 8px; }
        .terminal-msg .prompt { color: var(--neon-blue); font-weight: 700; }
        .terminal-msg .text { color: #d1d1d1; }
        .terminal-msg.user .prompt { color: var(--neon-purple); }
        .terminal-input-area { padding: 12px 16px; border-top: 1px solid var(--card-border); display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.2); flex-shrink: 0; }
        .terminal-input { flex: 1; background: transparent; border: none; outline: none; color: #fff; font-family: 'Outfit', monospace; font-size: 13px; }
        .terminal-input::placeholder { color: #444; }

        .conn-header { width: 100%; display: flex; justify-content: space-between; align-items: center; }
        .conn-header h3 { font-size: 14px; font-weight: 700; }
        .conn-visual { position: relative; width: 90px; height: 90px; display: flex; align-items: center; justify-content: center; }
        .circle-pulse { width: 65px; height: 65px; border-radius: 50%; background: rgba(0, 255, 157, 0.1); border: 2px solid var(--neon-green); display: flex; align-items: center; justify-content: center; position: relative; z-index: 2; }
        .circle-pulse i { color: var(--neon-green); font-size: 24px; }
        .conn-visual::before, .conn-visual::after { content: ''; position: absolute; width: 100%; height: 100%; border: 1px solid var(--neon-green); border-radius: 50%; opacity: 0; }
        .conn-visual.active::before { animation: ripple 2s infinite; }
        .conn-visual.active::after { animation: ripple 2s infinite 1s; }
        @keyframes ripple { 0% { transform: scale(0.8); opacity: 0.8; } 100% { transform: scale(1.5); opacity: 0; } }

        .conn-status { text-align: center; margin: 10px 0; }
        .conn-status h4 { font-size: 16px; font-weight: 700; color: var(--text-main); }
        .conn-status span { font-size: 11px; color: var(--neon-green); font-weight: 600; }

        .conn-stats { display: flex; gap: 20px; width: 100%; justify-content: center; padding: 10px 0; border-top: 1px solid var(--card-border); border-bottom: 1px solid var(--card-border); margin-bottom: 15px; }
        .stat-mini { text-align: center; }
        .stat-mini div { font-size: 14px; font-weight: 700; color: var(--text-main); }
        .stat-mini span { font-size: 9px; color: var(--text-muted); text-transform: uppercase; }

        .conn-btns { display: flex; gap: 10px; }
        .cbtn { flex: 1; padding: 8px; border-radius: var(--rad-sm); background: rgba(255,255,255,0.04); border: 1px solid var(--card-border); color: #fff; cursor: pointer; transition: 0.2s; font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 5px; }
        .cbtn:hover { background: rgba(255,255,255,0.08); }
        .cbtn:active { transform: scale(0.96); }

        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .card-header h3 { font-size: 14px; font-weight: 700; }
        .qbtns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .qbtn { background: rgba(255,255,255,0.02); border: 1px solid var(--card-border); border-radius: var(--rad-sm); padding: 10px; color: #fff; cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 11px; font-weight: 600; }
        .qbtn:hover { border-color: var(--neon-blue); background: rgba(0, 243, 255, 0.04); }
        .qbtn i { color: var(--neon-blue); font-size: 14px; }

        .log-list { display: flex; flex-direction: column; gap: 10px; flex: 1; overflow-y: auto; }
        .log-item { display: flex; align-items: center; gap: 12px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: var(--rad-sm); border: 1px solid var(--card-border); }
        .log-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; }
        .log-text { flex: 1; font-size: 12px; color: #ccc; }
        .log-time { font-size: 10px; color: var(--text-muted); }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }

        @media (max-width: 1100px) {
            .grid-layout { grid-template-columns: repeat(2, 1fr); grid-template-areas: "quote quote" "gauge gauge" "terminal terminal" "connection quick" "activity activity"; }
            body { overflow-y: auto; height: auto; }
        }
        @media (max-width: 768px) {
            .sidebar { display: none; }
            .grid-layout { grid-template-columns: 1fr; grid-template-areas: "quote" "gauge" "terminal" "connection" "quick" "activity"; }
        }
    </style>
</head>
<body>
    <div class="glow-orb orb-1"></div>
    <div class="glow-orb orb-2"></div>

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
            <div>
                <h1>Waheedomar <span>Radio</span>
                    <div class="status-pill"><div class="status-dot" id="statusDot"></div> <span id="statusText">Loading...</span></div>
                </h1>
                <p>Bot Dashboard &mdash; Live Monitoring</p>
            </div>
            <div class="header-right"></div>
        </header>

        <div class="grid-layout">
            <div class="card quote-card">
                <div class="quote-content">
                    <h2 id="nowPlayingTitle">Loading...<span id="nowPlayingChannel">--</span></h2>
                    <p id="nowPlayingMeta">--</p>
                </div>
                <div class="visualizer-3d">
                    <div class="bar-3d" style="animation-delay:0.1s"></div>
                    <div class="bar-3d" style="animation-delay:0.3s"></div>
                    <div class="bar-3d" style="animation-delay:0.5s"></div>
                    <div class="bar-3d" style="animation-delay:0.2s"></div>
                    <div class="bar-3d" style="animation-delay:0.4s"></div>
                </div>
            </div>

            <div class="card gauge-card">
                <div class="gauge-ring">
                    <div class="gauge-inner">
                        <div class="gauge-value" id="uptimeValue">--</div>
                        <div class="gauge-label">Uptime</div>
                    </div>
                </div>
                <div class="gauge-stats">
                    <div id="guildCount">--</div>
                    <span>Servers Connected</span>
                </div>
            </div>

            <div class="card terminal-card">
                <div class="terminal-header">
                    <div class="dots"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div></div>
                    <span class="terminal-title">Bot Terminal</span>
                </div>
                <div class="terminal-body" id="terminalBody">
                    <div class="terminal-msg"><span class="prompt">System:</span><span class="text">Type /help for commands.</span></div>
                </div>
                <div class="terminal-input-area">
                    <i class="fas fa-chevron-left" style="color:var(--neon-green);font-size:12px;"></i>
                    <input type="text" class="terminal-input" id="cmdInput" placeholder="Type command..." autofocus>
                </div>
            </div>

            <div class="card connection-card">
                <div class="conn-header"><h3>Voice Connection</h3></div>
                <div class="conn-visual active"><div class="circle-pulse"><i class="fas fa-microphone"></i></div></div>
                <div class="conn-status">
                    <h4 id="connGuildName">--</h4>
                    <span id="connStatusText">--</span>
                </div>
                <div class="conn-stats">
                    <div class="stat-mini"><div id="memValue">--</div><span>Memory</span></div>
                    <div class="stat-mini"><div id="pidValue">--</div><span>PID</span></div>
                </div>
                <div class="conn-btns">
                    <button class="cbtn" onclick="sendCmd('/عشوائي')"><i class="fas fa-play"></i> Random</button>
                    <button class="cbtn" onclick="sendCmd('/كمل')"><i class="fas fa-redo"></i> Resume</button>
                    <button class="cbtn" onclick="sendCmd('/اخر_مقطع')"><i class="fas fa-forward"></i> Latest</button>
                </div>
            </div>

            <div class="card quick-card">
                <div class="card-header"><h3 style="font-size:12px;color:var(--text-muted);">Quick Actions</h3></div>
                <div class="qbtns">
                    <button class="qbtn" onclick="sendCmd('skip')"><i class="fas fa-forward"></i> Skip</button>
                    <button class="qbtn" onclick="sendCmd('np')"><i class="fas fa-info-circle"></i> Now Playing</button>
                    <button class="qbtn" onclick="sendCmd('queue')"><i class="fas fa-list"></i> Queue</button>
                    <button class="qbtn" onclick="sendCmd('status')"><i class="fas fa-chart-bar"></i> Status</button>
                </div>
            </div>

            <div class="card activity-card">
                <div class="card-header"><h3>Activity Log</h3></div>
                <div class="log-list" id="logList">
                    <div class="log-item">
                        <div class="log-icon" style="background:rgba(0,255,157,0.08);color:var(--neon-green);"><i class="fas fa-check"></i></div>
                        <div class="log-text">Dashboard connected</div>
                        <div class="log-time">now</div>
                    </div>
                </div>
            </div>
        </div>
    </main>

    <script>
        const terminalBody = document.getElementById('terminalBody');
        const cmdInput = document.getElementById('cmdInput');
        const logList = document.getElementById('logList');
        let cmdHistory = [];
        let cmdIndex = -1;

        function addLog(icon, color, text) {
            const item = document.createElement('div');
            item.className = 'log-item';
            item.innerHTML = '<div class="log-icon" style="background:' + color + '10;color:' + color + ';"><i class="fas fa-' + icon + '"></i></div><div class="log-text">' + text + '</div><div class="log-time">now</div>';
            logList.insertBefore(item, logList.firstChild);
            if (logList.children.length > 20) logList.removeChild(logList.lastChild);
        }

        function addTerminalMsg(prompt, text, type) {
            const msg = document.createElement('div');
            msg.className = 'terminal-msg ' + (type || '');
            msg.innerHTML = '<span class="prompt">' + prompt + '</span><span class="text">' + text + '</span>';
            terminalBody.appendChild(msg);
            terminalBody.scrollTop = terminalBody.scrollHeight;
        }

        async function sendCmd(cmd) {
            addTerminalMsg('Admin>', cmd, 'user');
            addLog('terminal', '#bc13fe', 'Command: ' + cmd);
            try {
                const res = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) });
                const data = await res.json();
                addTerminalMsg('Bot>', data.reply || data.error || 'Done.', 'bot');
            } catch (e) {
                addTerminalMsg('Error>', e.message, 'bot');
            }
        }

        cmdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && cmdInput.value.trim()) {
                cmdHistory.push(cmdInput.value.trim());
                cmdIndex = cmdHistory.length;
                sendCmd(cmdInput.value.trim());
                cmdInput.value = '';
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (cmdIndex > 0) { cmdIndex--; cmdInput.value = cmdHistory[cmdIndex]; }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (cmdIndex < cmdHistory.length - 1) { cmdIndex++; cmdInput.value = cmdHistory[cmdIndex]; } else { cmdIndex = cmdHistory.length; cmdInput.value = ''; }
            }
        });

        async function refreshData() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();

                document.getElementById('statusDot').style.background = 'var(--neon-green)';
                document.getElementById('statusText').textContent = 'Bot Online';

                document.getElementById('uptimeValue').textContent = formatUptime(data.uptime);
                document.getElementById('guildCount').textContent = data.guilds;
                document.getElementById('memValue').textContent = data.memMB + 'MB';
                document.getElementById('pidValue').textContent = data.pid;

                if (data.sessions.length > 0) {
                    const s = data.sessions[0];
                    document.getElementById('nowPlayingTitle').textContent = s.title || 'No Track';
                    document.getElementById('nowPlayingChannel').textContent = s.guildName || '--';
                    document.getElementById('nowPlayingMeta').textContent = (s.mode || '') + ' | Volume: ' + (s.volume || 0) + '% | ' + (s.connected ? 'Connected' : 'Disconnected');
                    document.getElementById('connGuildName').textContent = s.guildName || '--';
                    document.getElementById('connStatusText').textContent = s.connected ? 'Connected' : 'Disconnected';
                    document.getElementById('connStatusText').style.color = s.connected ? 'var(--neon-green)' : 'var(--neon-red)';
                }
            } catch (e) {
                document.getElementById('statusText').textContent = 'Offline';
                document.getElementById('statusDot').style.background = 'var(--neon-red)';
            }
        }

        function formatUptime(s) {
            var d = Math.floor(s / 86400);
            var h = Math.floor((s % 86400) / 3600);
            var m = Math.floor((s % 3600) / 60);
            return d > 0 ? d + 'd ' + h + 'h' : h > 0 ? h + 'h ' + m + 'm' : m + 'm';
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
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // Health check
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
        return;
      }

      // API: status
      if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getApiData()));
        return;
      }

      // API: command
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

      // Dashboard HTML
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
