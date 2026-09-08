import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---- formatTime (embeds.js) ----

function formatTime(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '0:00';
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

describe('formatTime', () => {
  it('formats seconds only', () => assert.equal(formatTime(45), '0:45'));
  it('formats minutes and seconds', () => assert.equal(formatTime(125), '2:05'));
  it('formats hours', () => assert.equal(formatTime(3661), '1:01:01'));
  it('handles 0', () => assert.equal(formatTime(0), '0:00'));
  it('handles null', () => assert.equal(formatTime(null), '0:00'));
  it('handles NaN', () => assert.equal(formatTime(NaN), '0:00'));
  it('handles negative', () => assert.equal(formatTime(-10), '0:00'));
});

// ---- parseIsoDuration (youtube.js) ----

function parseIsoDuration(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!match) return null;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

describe('parseIsoDuration', () => {
  it('parses hours', () => assert.equal(parseIsoDuration('PT1H30M'), 5400));
  it('parses minutes only', () => assert.equal(parseIsoDuration('PT5M30S'), 330));
  it('parses seconds only', () => assert.equal(parseIsoDuration('PT45S'), 45));
  it('parses full', () => assert.equal(parseIsoDuration('PT2H10M5S'), 7805));
  it('returns null for bad input', () => assert.equal(parseIsoDuration('bad'), null));
  it('returns null for empty', () => assert.equal(parseIsoDuration(''), null));
});

// ---- jitteredDelay (player.js) ----

function jitteredDelay(baseMs, attempt) {
  const maxMs = 60_000;
  const delay = Math.min(baseMs * attempt, maxMs);
  const jitter = delay * (0.8 + Math.random() * 0.4);
  return Math.floor(jitter);
}

describe('jitteredDelay', () => {
  it('increases with attempt', () => {
    const d1 = jitteredDelay(5000, 1);
    const d2 = jitteredDelay(5000, 5);
    assert.ok(d2 > d1, `d2 (${d2}) should be > d1 (${d1})`);
  });
  it('respects max cap', () => {
    const d = jitteredDelay(5000, 20);
    assert.ok(d <= 60_000 * 1.2, `delay (${d}) should be <= 72000`);
  });
  it('stays within ±20% jitter range', () => {
    const base = 5000;
    for (let i = 0; i < 20; i++) {
      const d = jitteredDelay(base, 3);
      assert.ok(d >= base * 3 * 0.8, `delay (${d}) too low`);
      assert.ok(d <= base * 3 * 1.2, `delay (${d}) too high`);
    }
  });
});

// ---- pickJingle (player.js) ----

const jingleLastPlayed = new Map();

function pickJingle(sounds) {
  if (sounds.length === 0) return null;
  if (sounds.length === 1) return sounds[0];
  const now = Date.now();
  const weights = sounds.map((name) => {
    const last = jingleLastPlayed.get(name) || 0;
    const age = now - last;
    return Math.max(1, age / 60_000);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < sounds.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      jingleLastPlayed.set(sounds[i], now);
      return sounds[i];
    }
  }
  const fallback = sounds[sounds.length - 1];
  jingleLastPlayed.set(fallback, now);
  return fallback;
}

describe('pickJingle', () => {
  it('returns null for empty', () => assert.equal(pickJingle([]), null));
  it('returns the only sound', () => assert.equal(pickJingle(['a']), 'a'));
  it('always returns a valid sound', () => {
    const sounds = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) {
      const picked = pickJingle(sounds);
      assert.ok(sounds.includes(picked));
    }
  });
});

// ---- formatViewCount (embeds.js) ----

function formatViewCount(viewCount) {
  if (viewCount == null) return null;
  if (viewCount >= 1_000_000) return `${(viewCount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (viewCount >= 1_000) return `${(viewCount / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(viewCount);
}

describe('formatViewCount', () => {
  it('formats millions', () => assert.equal(formatViewCount(1500000), '1.5M'));
  it('formats thousands', () => assert.equal(formatViewCount(2300), '2.3K'));
  it('formats small', () => assert.equal(formatViewCount(42), '42'));
  it('handles null', () => assert.equal(formatViewCount(null), null));
});
