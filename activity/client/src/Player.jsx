/**
 * Player.jsx — Synchronized YouTube IFrame Player.
 *
 * Uses the YouTube IFrame API to play the current video.
 * Corrects drift every tick if the local playback position
 * deviates from the expected server position by > 1.5s.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';

const DRIFT_THRESHOLD = 1.5;
const TICK_INTERVAL = 2000;

export default function Player({ videoId, elapsedSeconds, durationSeconds, paused, updatedAt }) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const [playerReady, setPlayerReady] = useState(false);
  const currentVideoIdRef = useRef(null);

  // Load YouTube IFrame API
  useEffect(() => {
    if (window.YT && window.YT.Player) return;

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      initPlayer();
    };

    return () => {
      window.onYouTubeIframeAPIReady = null;
    };
  }, []);

  function initPlayer() {
    if (playerRef.current) return;

    const player = new window.YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        modestbranding: 1,
        rel: 0,
        showinfo: 0,
        start: 0,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          setPlayerReady(true);
        },
        onStateChange: (event) => {
          // We handle sync externally
        },
      },
    });

    playerRef.current = player;
  }

  // Sync with server state
  useEffect(() => {
    if (!playerReady || !playerRef.current || !videoId) return;

    const player = playerRef.current;

    // Load new video if changed
    if (videoId !== currentVideoIdRef.current) {
      currentVideoIdRef.current = videoId;
      const startAt = Math.max(0, elapsedSeconds || 0);
      player.loadVideoById({ videoId, startSeconds: startAt });
      return;
    }

    // Sync position (drift correction)
    const expectedTime = (elapsedSeconds || 0) + ((Date.now() - (updatedAt || Date.now())) / 1000);
    const currentTime = player.getCurrentTime();
    const drift = Math.abs(currentTime - expectedTime);

    if (drift > DRIFT_THRESHOLD) {
      player.seekTo(expectedTime, true);
    }

    // Sync pause state
    if (paused && player.getPlayerState() === 1) {
      player.pauseVideo();
    } else if (!paused && player.getPlayerState() === 2) {
      player.playVideo();
    }
  }, [videoId, elapsedSeconds, paused, updatedAt, playerReady]);

  return (
    <div style={styles.wrapper} className="activity-player">
      <div style={styles.playerContainer} ref={containerRef}>
        <div id="youtube-player" style={styles.iframe} />
      </div>

      {/* Video info overlay */}
      {durationSeconds > 0 && (
        <div style={styles.progressBar}>
          <div style={{
            ...styles.progressFill,
            width: `${Math.min(100, ((elapsedSeconds || 0) / durationSeconds) * 100)}%`,
          }} />
        </div>
      )}
    </div>
  );
}

const styles = {
  wrapper: {
    width: '100%',
    maxWidth: '900px',
    aspectRatio: '16/9',
    position: 'relative',
  },
  playerContainer: {
    width: '100%',
    height: '100%',
    borderRadius: '12px',
    overflow: 'hidden',
    background: '#000',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
  },
  progressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '3px',
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '0 0 12px 12px',
  },
  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #00E5FF, #A855F7)',
    borderRadius: '0 0 12px 12px',
    transition: 'width 2s linear',
  },
};
