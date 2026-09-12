/**
 * App.jsx — Root component.
 *
 * Flow:
 *   1. Initialize Discord SDK
 *   2. Authorize (identify, guilds)
 *   3. Exchange code for access_token via our server
 *   4. Fetch user + guild info
 *   5. Render Player + JingleOverlay
 */

import React, { useState, useEffect, useCallback } from 'react';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import Player from './Player.jsx';
import JingleOverlay from './JingleOverlay.jsx';
import { useSocket } from './socket.js';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || '';
const BOT_PORT = import.meta.env.VITE_BOT_PORT || '3333';

const COLORS = {
  cyan: '#00E5FF',
  orange: '#FF6B35',
  purple: '#A855F7',
  bg: '#0a0a0a',
  surface: '#1a1a2e',
  surfaceLight: '#16213e',
};

export default function App() {
  const [sdk, setSdk] = useState(null);
  const [user, setUser] = useState(null);
  const [guild, setGuild] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { state, jingles, connected } = useSocket(BOT_PORT);

  // Initialize Discord SDK
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        if (!CLIENT_ID) {
          throw new Error('VITE_DISCORD_CLIENT_ID is not set');
        }

        const discordSdk = new DiscordSDK(CLIENT_ID);
        await discordSdk.ready();

        if (cancelled) return;

        // Authorize with the SDK
        const { code } = await discordSdk.commands.authorize({
          client_id: CLIENT_ID,
          response_type: 'code',
          state: '',
          scope: ['identify', 'guilds'],
        });

        if (cancelled) return;

        // Exchange code for access_token via our server
        const tokenRes = await fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });

        if (!tokenRes.ok) {
          throw new Error('Failed to exchange OAuth code');
        }

        const { access_token } = await tokenRes.json();

        // Set the auth token in the SDK
        await discordSdk.commands.setOAuth2Token(access_token);

        if (cancelled) return;

        // Fetch user info
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const userData = await userRes.json();
        if (cancelled) return;
        setUser(userData);

        // Fetch current guild
        const guildRes = await fetch('https://discord.com/api/users/@me/guilds', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const guilds = await guildRes.json();
        if (cancelled) return;

        // Find the guild this activity was launched from
        const currentGuildId = discordSdk.guildId;
        const currentGuild = guilds.find(g => g.id === currentGuildId);
        if (currentGuild) {
          setGuild(currentGuild);
        }

        setSdk(discordSdk);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error('[activity] Init error:', err);
          setError(err.message);
          setLoading(false);
        }
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loadingBox}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>جاري التحميل...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.errorBox}>
          <p style={styles.errorIcon}>⚠️</p>
          <p style={styles.errorText}>{error}</p>
          <p style={styles.errorHint}>تأكد من فتح هذا من داخل تطبيق ديسكورد</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Background gradient */}
      <div style={styles.bgGradient} />

      {/* Header */}
      <div style={styles.header} className="activity-header">
        <div style={styles.headerLeft}>
          <span style={styles.headerIcon}>🎙️</span>
          <span style={styles.headerTitle} className="activity-header-title">راديو وحيد عمر</span>
        </div>
        {user && (
          <div style={styles.headerRight}>
            <img
              src={user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`}
              alt=""
              style={styles.avatar}
              className="activity-header-avatar"
            />
            <span style={styles.username} className="activity-header-username">{user.username}</span>
          </div>
        )}
      </div>

      {/* Main content */}
      <div style={styles.content} className="activity-content">
        <Player
          videoId={state?.videoId}
          elapsedSeconds={state?.elapsedSeconds}
          durationSeconds={state?.durationSeconds}
          paused={state?.paused}
          updatedAt={state?.updatedAt}
        />
      </div>

      {/* Jingle overlay */}
      <JingleOverlay jingles={jingles} />

      {/* Connection indicator */}
      <div style={{
        ...styles.connectionDot,
        backgroundColor: connected ? COLORS.cyan : '#ff4444',
      }} title={connected ? 'متصل' : 'غير متصل'} />
    </div>
  );
}

const styles = {
  container: {
    width: '100vw',
    height: '100vh',
    position: 'relative',
    overflow: 'hidden',
    fontFamily: "'IBM Plex Sans Arabic', 'Inter', sans-serif",
  },
  bgGradient: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(ellipse at 50% 0%, #1a1a2e 0%, #0a0a0a 70%)',
    zIndex: 0,
  },
  header: {
    position: 'relative',
    zIndex: 10,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 20px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerIcon: {
    fontSize: '20px',
  },
  headerTitle: {
    fontSize: '16px',
    fontWeight: 700,
    background: 'linear-gradient(135deg, #00E5FF, #A855F7)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  avatar: {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
  },
  username: {
    fontSize: '13px',
    color: '#999',
  },
  content: {
    position: 'relative',
    zIndex: 5,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: 'calc(100vh - 56px)',
  },
  connectionDot: {
    position: 'absolute',
    bottom: '12px',
    left: '12px',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    zIndex: 20,
  },
  loadingBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '16px',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '3px solid rgba(0,229,255,0.2)',
    borderTopColor: '#00E5FF',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  loadingText: {
    color: '#999',
    fontSize: '14px',
  },
  errorBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    padding: '32px',
    background: 'rgba(255,68,68,0.1)',
    borderRadius: '12px',
    border: '1px solid rgba(255,68,68,0.2)',
  },
  errorIcon: {
    fontSize: '32px',
  },
  errorText: {
    color: '#ff6666',
    fontSize: '14px',
    textAlign: 'center',
  },
  errorHint: {
    color: '#666',
    fontSize: '12px',
    textAlign: 'center',
  },
};

// Add spin animation
const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
