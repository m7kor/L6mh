/**
 * JingleOverlay.jsx — Enhanced jingle/latma animation overlay.
 *
 * Multi-layer visual effect:
 *   1. Full-screen color flash (300ms)
 *   2. Centered card with pulse rings
 *   3. Particle burst effect
 *   4. Category-specific styling (latma/basmala/general)
 */

import React, { useState, useEffect, useRef } from 'react';

const ANIMATION_DURATION = 3500;

const CATEGORIES = {
  latma: {
    emoji: '💥',
    label: 'لطمة!',
    gradient: 'linear-gradient(135deg, #FF6B35, #FF2D2D)',
    glow: 'rgba(255, 107, 53, 0.5)',
    flash: 'radial-gradient(circle, rgba(255,107,53,0.35) 0%, transparent 55%)',
    particles: ['#FF6B35', '#FF2D2D', '#FFB366'],
  },
  basmala: {
    emoji: '✨',
    label: 'بسم الله',
    gradient: 'linear-gradient(135deg, #A855F7, #6366F1)',
    glow: 'rgba(168, 85, 247, 0.5)',
    flash: 'radial-gradient(circle, rgba(168,85,247,0.35) 0%, transparent 55%)',
    particles: ['#A855F7', '#6366F1', '#C084FC'],
  },
  general: {
    emoji: '🎵',
    label: 'فواصل',
    gradient: 'linear-gradient(135deg, #00E5FF, #0EA5E9)',
    glow: 'rgba(0, 229, 255, 0.5)',
    flash: 'radial-gradient(circle, rgba(0,229,255,0.3) 0%, transparent 55%)',
    particles: ['#00E5FF', '#0EA5E9', '#67E8F9'],
  },
};

function Particle({ color, delay, angle }) {
  const rad = (angle * Math.PI) / 180;
  const dist = 60 + Math.random() * 80;
  const tx = Math.cos(rad) * dist;
  const ty = Math.sin(rad) * dist;

  return (
    <div style={{
      position: 'absolute',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: color,
      top: '50%',
      left: '50%',
      transform: `translate(-50%, -50%)`,
      animation: `particleBurst 0.8s ${delay}s ease-out forwards`,
      ['--tx']: `${tx}px`,
      ['--ty']: `${ty}px`,
    }} />
  );
}

export default function JingleOverlay({ jingles }) {
  const [active, setActive] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle, flash, card, fade
  const lastEventRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!jingles || jingles.length === 0) return;

    const latest = jingles[jingles.length - 1];
    if (!latest || latest.at === lastEventRef.current) return;

    lastEventRef.current = latest.at;

    if (timerRef.current) clearTimeout(timerRef.current);

    setActive(latest);
    setPhase('flash');

    // Flash phase
    timerRef.current = setTimeout(() => {
      setPhase('card');
      // Card phase
      timerRef.current = setTimeout(() => {
        setPhase('fade');
        // Fade phase
        timerRef.current = setTimeout(() => {
          setPhase('idle');
          setActive(null);
        }, 600);
      }, ANIMATION_DURATION);
    }, 200);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [jingles]);

  if (!active || phase === 'idle') return null;

  const cat = CATEGORIES[active.category] || CATEGORIES.general;
  const particles = Array.from({ length: 12 }, (_, i) => ({
    color: cat.particles[i % cat.particles.length],
    delay: i * 0.03,
    angle: (i * 30) + (Math.random() * 15 - 7.5),
  }));

  return (
    <div style={styles.overlay}>
      {/* Full-screen flash */}
      <div style={{
        ...styles.flash,
        background: cat.flash,
        opacity: phase === 'flash' ? 1 : 0,
        transition: 'opacity 0.3s ease',
      }} />

      {/* Card */}
      <div style={{
        ...styles.card,
        opacity: phase === 'card' ? 1 : phase === 'fade' ? 0 : 0,
        transform: phase === 'card' ? 'scale(1)' : phase === 'fade' ? 'scale(0.9)' : 'scale(0.7)',
        boxShadow: `0 0 80px ${cat.glow}, 0 0 160px ${cat.glow}40`,
      }}>
        {/* Pulse rings */}
        <div style={{ ...styles.ring, borderColor: cat.glow, animationDelay: '0s' }} />
        <div style={{ ...styles.ring, borderColor: cat.glow, animationDelay: '0.3s' }} />
        <div style={{ ...styles.ring, borderColor: cat.glow, animationDelay: '0.6s' }} />

        {/* Particles */}
        <div style={styles.particleContainer}>
          {phase === 'card' && particles.map((p, i) => (
            <Particle key={`${active.at}-${i}`} {...p} />
          ))}
        </div>

        {/* Emoji */}
        <div style={styles.emoji}>{cat.emoji}</div>

        {/* Label */}
        <div style={{
          ...styles.label,
          background: cat.gradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          {cat.label}
        </div>

        {/* Name */}
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
  },
  flash: {
    position: 'absolute',
    inset: 0,
  },
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '10px',
    padding: '40px 56px',
    borderRadius: '20px',
    background: 'rgba(10, 10, 10, 0.9)',
    backdropFilter: 'blur(24px)',
    border: '1px solid rgba(255,255,255,0.08)',
    transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  ring: {
    position: 'absolute',
    width: '140px',
    height: '140px',
    borderRadius: '50%',
    border: '2px solid',
    animation: 'jingleRing 1.5s ease-out infinite',
  },
  particleContainer: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    top: 0,
    left: 0,
    overflow: 'visible',
  },
  emoji: {
    fontSize: '56px',
    lineHeight: 1,
    position: 'relative',
    zIndex: 2,
  },
  label: {
    fontSize: '16px',
    fontWeight: 800,
    letterSpacing: '3px',
    textTransform: 'uppercase',
    position: 'relative',
    zIndex: 2,
  },
  name: {
    fontSize: '15px',
    color: '#ccc',
    fontWeight: 500,
    textAlign: 'center',
    maxWidth: '320px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    position: 'relative',
    zIndex: 2,
  },
};

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes jingleRing {
    0% { transform: scale(0.6); opacity: 1; }
    100% { transform: scale(2.5); opacity: 0; }
  }
  @keyframes particleBurst {
    0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0); opacity: 0; }
  }
`;
document.head.appendChild(style);
