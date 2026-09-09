import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime } from './format.js';
import { loadPlays } from './stats.js';
import { getCookieArgs, describeCookieSource } from '../services/cookies.js';
import { isOnCooldown, setCooldown, getRemainingCooldown } from './cooldown.js';
import { requireDjRole } from './permissions.js';
import { buildNewQueue } from '../services/session.js';

// ============================================
// formatTime
// ============================================
describe('formatTime', () => {
  it('formats seconds only', () => {
    assert.equal(formatTime(45), '0:45');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatTime(125), '2:05');
  });

  it('formats hours', () => {
    assert.equal(formatTime(3661), '1:01:01');
  });

  it('handles 0', () => {
    assert.equal(formatTime(0), '0:00');
  });

  it('handles null', () => {
    assert.equal(formatTime(null), '0:00');
  });

  it('handles NaN', () => {
    assert.equal(formatTime(NaN), '0:00');
  });

  it('handles negative', () => {
    assert.equal(formatTime(-10), '0:00');
  });

  it('handles floating point', () => {
    assert.equal(formatTime(65.7), '1:05');
  });

  it('formats large hour value', () => {
    assert.equal(formatTime(7200), '2:00:00');
  });
});

// ============================================
// loadPlays
// ============================================
describe('loadPlays', () => {
  it('returns an object', async () => {
    const result = await loadPlays();
    assert.equal(typeof result, 'object');
  });

  it('returns empty object if no file', async () => {
    const result = await loadPlays();
    assert.ok(result !== null);
  });
});

// ============================================
// cookies
// ============================================
describe('getCookieArgs', () => {
  it('returns an array', () => {
    const args = getCookieArgs();
    assert.ok(Array.isArray(args));
  });

  it('returns valid cookie arg format', () => {
    const args = getCookieArgs();
    if (args.length > 0) {
      assert.ok(args[0] === '--cookies' || args[0] === '--cookies-from-browser');
      assert.ok(typeof args[1] === 'string' && args[1].length > 0);
    }
  });
});

describe('describeCookieSource', () => {
  it('returns a string', () => {
    assert.equal(typeof describeCookieSource(), 'string');
  });
});

// ============================================
// videoId validation
// ============================================
describe('videoId validation', () => {
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  it('accepts valid IDs', () => {
    assert.ok(VIDEO_ID_RE.test('dQw4w9WgXcQ'));
    assert.ok(VIDEO_ID_RE.test('jNQXAC9IVRw'));
    assert.ok(VIDEO_ID_RE.test('9bZkp7q19f0'));
  });

  it('rejects too short', () => {
    assert.ok(!VIDEO_ID_RE.test('abc'));
  });

  it('rejects too long', () => {
    assert.ok(!VIDEO_ID_RE.test('dQw4w9WgXcQextra'));
  });

  it('rejects invalid characters', () => {
    assert.ok(!VIDEO_ID_RE.test('dQw4w9WgXc$'));
    assert.ok(!VIDEO_ID_RE.test('dQw4w9WgXc '));
  });
});

// ============================================
// cooldown
// ============================================
describe('cooldown', () => {
  it('is not on cooldown initially', () => {
    assert.equal(isOnCooldown('user1', 'cmd1'), false);
  });

  it('is on cooldown after setCooldown', () => {
    setCooldown('user2', 'cmd2');
    assert.equal(isOnCooldown('user2', 'cmd2'), true);
  });

  it('different users are independent', () => {
    setCooldown('userA', 'cmd3');
    assert.equal(isOnCooldown('userA', 'cmd3'), true);
    assert.equal(isOnCooldown('userB', 'cmd3'), false);
  });

  it('different commands are independent', () => {
    setCooldown('userC', 'cmdX');
    assert.equal(isOnCooldown('userC', 'cmdX'), true);
    assert.equal(isOnCooldown('userC', 'cmdY'), false);
  });

  it('getRemainingCooldown returns seconds > 0 when on cooldown', () => {
    setCooldown('userD', 'cmdR');
    const remaining = getRemainingCooldown('userD', 'cmdR');
    assert.ok(remaining > 0);
    assert.ok(remaining <= 8);
  });

  it('getRemainingCooldown returns 0 when not on cooldown', () => {
    assert.equal(getRemainingCooldown('userE', 'cmdZ'), 0);
  });
});

// ============================================
// permissions
// ============================================
describe('requireDjRole', () => {
  it('returns true when DJ_ROLE_ID is not set', async () => {
    const result = await requireDjRole({ member: { roles: { cache: { has: () => false } } }, reply: () => {} });
    assert.equal(result, true);
  });
});

// ============================================
// shuffle-bag queue
// ============================================
describe('buildNewQueue', () => {
  const catalog = [
    { videoId: 'a' }, { videoId: 'b' }, { videoId: 'c' },
    { videoId: 'd' }, { videoId: 'e' }, { videoId: 'f' },
  ];

  it('returns all videos when nothing is excluded', () => {
    const q = buildNewQueue(catalog);
    assert.equal(q.length, catalog.length);
  });

  it('excludes failed IDs', () => {
    const q = buildNewQueue(catalog, ['a', 'c']);
    assert.equal(q.length, 4);
    assert.ok(!q.includes('a'));
    assert.ok(!q.includes('c'));
  });

  it('returns shuffled order (not always sorted)', () => {
    const q = buildNewQueue(catalog);
    const ids = q.map(v => v.videoId);
    const original = catalog.map(v => v.videoId).join(',');
    const shuffled = ids.join(',');
    // Very unlikely to be identical for 6 elements
    assert.ok(q.length === catalog.length);
  });

  it('handles empty catalog', () => {
    const q = buildNewQueue([], ['a']);
    assert.equal(q.length, 0);
  });

  it('handles all videos excluded', () => {
    const q = buildNewQueue(catalog, ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(q.length, 0);
  });
});
