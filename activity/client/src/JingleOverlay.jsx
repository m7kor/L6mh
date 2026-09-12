/**
 * JingleOverlay.jsx — Visual jingle/latma animation overlay.
 *
 * When a jingle event is received, displays a short animation
 * with the jingle name and a category-specific visual effect.
 * Auto-hides after 3 seconds.
 */

import React, { useState, useEffect, useRef } from 'react';

const ANIMATION_DURATION = 3000;

const CATEGORY_STYLES = {
  latma: {
    emoji: '💥',
    gradient: 'linear-gradient(135deg, #FF6B35, #FF2D2D)',
    shadowColor: 'rgba(255, 107, 53, 0.4)',
    label: 'لطمة',
  },
  basmala: {
    emoji: '✨',
    gradient: 'linear-gradient(135deg, #A855F7, #6366F1)',
    shadowColor: 'rgba(168, 85, 247, 0.4)',
    label: 'بسم الله',
  },
  general: {
    emoji: '🎵',
    gradient: 'linear-gradient(135deg, #00E5FF, #0EA5E9)',
    shadowColor: 'rgba(0, 229, 255, 0.4)',
    label: 'فواصل',
  },
};

export default function JingleOverlay({ jingles }) {
  const [active, setActive] = useState(null);
  const [animating, setAnimating] = useState(false);
  const lastEventRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!jingles || jingles.length === 0) return;

    const latest = jingles[jingles.length - 1];
    if (!latest || latest.at === lastEventRef.current) return;

    lastEventRef.current = latest.at;

    // Clear any existing timer
    if (timerRef.current) clearTimeout(timerRef.current);

    // Show animation
    setActive(latest);
    setAnimating(true);

    // Auto-hide
    timerRef.current = setTimeout(() => {
      setAnimating(false);
      setTimeout(() => setActive(null), 500); // Wait for fade-out
    }, ANIMATION_DURATION);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [jingles]);

  if (!active) return null;

  const style = CATEGORY_STYLES[active.category] || CATEGORY_STYLES.general;

  return (
    <div style={{
      ...styles.overlay,
      opacity: animating ? 1 : 0,
      transform: animating ? 'scale(1)' : 'scale(0.8)',
    }}>
      {/* Flash effect */}
      <div style={{
        ...styles.flash,
        background: style.gradient,
        opacity: animating ? 0.15 : 0,
      }} />

      {/* Content */}
      <div style={{
        ...styles.content,
        boxShadow: `0 0 60px ${style.shadowColor}`,
      }}>
        {/* Pulse ring */}
        <div style={{
          ...styles.pulseRing,
          borderColor: style.shadowColor,
          animation: animating ? 'pulse 1.5s ease-out infinite' : 'none',
        }} />

        {/* Emoji */}
        <div style={styles.emoji}>{style.emoji}</div>

        {/* Label */}
        <div style={{
          ...styles.label,
          background: style.gradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          {style.label}
        </div>

        {/* Jingle name */}
        <div style={styles.name}>{active.name}</div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
    pointerEvents: 'none',
    transition: 'opacity 0.5s ease, transform 0.5s ease',
  },
  flash: {
    position: 'absolute',
    inset: 0,
    transition: 'opacity 0.3s ease',
  },
  content: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    padding: '32px 48px',
    borderRadius: '16px',
    background: 'rgba(10, 10, 10, 0.85)',
    backdropFilter: 'blur(20px)',
  },
  pulseRing: {
    position: 'absolute',
    width: '120px',
    height: '120px',
    borderRadius: '50%',
    border: '2px solid',
    animation: 'pulse 1.5s ease-out infinite',
  },
  emoji: {
    fontSize: '48px',
    lineHeight: 1,
  },
  label: {
    fontSize: '14px',
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
  },
  name: {
    fontSize: '16px',
    color: '#e0e0e0',
    fontWeight: 500,
    textAlign: 'center',
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

// Add pulse animation
const style = document.createElement('style');
style.textContent = `
  @keyframes pulse {
    0% { transform: scale(0.8); opacity: 1; }
    100% { transform: scale(2); opacity: 0; }
  }
`;
document.head.appendChild(style);
