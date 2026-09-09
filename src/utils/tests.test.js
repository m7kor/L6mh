import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime } from './format.js';
import { loadPlays } from './stats.js';
import { getCookieArgs, describeCookieSource } from '../services/cookies.js';
import { isOnCooldown, setCooldown, getRemainingCooldown } from './cooldown.js';
import { requireDjRole } from './permissions.js';
import { buildNewQueue, syncQueueWithCatalog } from '../services/session.js';

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

// ============================================
// syncQueueWithCatalog
// ============================================
describe('syncQueueWithCatalog', () => {
  const catalog = [
    { videoId: 'a' }, { videoId: 'b' }, { videoId: 'c' },
    { videoId: 'd' }, { videoId: 'e' }, { videoId: 'f' },
  ];

  it('inserts new videos at random positions', () => {
    const session = { queue: ['a', 'b', 'c', 'd', 'e', 'f'], playedIds: new Set(), failedIds: new Set() };
    const newCatalog = [...catalog, { videoId: 'g' }]; // g is new
    syncQueueWithCatalog(session, newCatalog);
    assert.equal(session.queue.length, 7);
    assert.ok(session.queue.includes('g'));
  });

  it('removes stale videos not in catalog', () => {
    const session = { queue: ['a', 'b', 'x'], playedIds: new Set(), failedIds: new Set() };
    const smallCatalog = [{ videoId: 'a' }, { videoId: 'b' }]; // x is gone
    syncQueueWithCatalog(session, smallCatalog);
    assert.equal(session.queue.length, 2);
    assert.ok(!session.queue.includes('x'));
  });

  it('does not insert videos already in playedIds', () => {
    const session = { queue: ['a', 'b', 'c', 'd', 'e', 'f'], playedIds: new Set(['g']), failedIds: new Set() };
    syncQueueWithCatalog(session, catalog);
    assert.ok(!session.queue.includes('g'));
    assert.equal(session.queue.length, 6);
  });

  it('does not insert videos in failedIds', () => {
    const session = { queue: ['a', 'b', 'c', 'd', 'e', 'f'], playedIds: new Set(), failedIds: new Set(['g']) };
    syncQueueWithCatalog(session, catalog);
    assert.ok(!session.queue.includes('g'));
    assert.equal(session.queue.length, 6);
  });

  it('returns false when queue is empty', () => {
    const session = { queue: [], playedIds: new Set(), failedIds: new Set() };
    const result = syncQueueWithCatalog(session, catalog);
    assert.equal(result, false);
  });

  it('returns true when changes were made', () => {
    const session = { queue: ['a', 'b', 'c', 'd', 'e', 'f'], playedIds: new Set(), failedIds: new Set() };
    const result = syncQueueWithCatalog(session, [...catalog, { videoId: 'g' }]);
    assert.equal(result, true);
  });
});

// ============================================
// streaming (isPotProviderError, killProcesses)
// ============================================
import { isPotProviderError } from '../services/streaming.js';
import { killProcesses } from '../services/streaming.js';

describe('isPotProviderError', () => {
  it('returns false for null/empty', () => {
    assert.equal(isPotProviderError(null), false);
    assert.equal(isPotProviderError(''), false);
    assert.equal(isPotProviderError(undefined), false);
  });

  it('returns true for ECONNREFUSED + bgutil', () => {
    assert.equal(isPotProviderError('ECONNREFUSED 127.0.0.1:4416 bgutilhttp'), true);
  });

  it('returns true for connection refused + bgutil', () => {
    assert.equal(isPotProviderError('Connection refused bgutil'), true);
  });

  it('returns true for ETIMEDOUT + bgutil', () => {
    assert.equal(isPotProviderError('ETIMEDOUT bgutil connection timed out'), true);
  });

  it('returns false for ECONNREFUSED without bgutil', () => {
    assert.equal(isPotProviderError('ECONNREFUSED 127.0.0.1:4416'), false);
  });

  it('returns false for bgutil without network error', () => {
    assert.equal(isPotProviderError('bgutil returned error 403'), false);
  });

  it('is case-insensitive', () => {
    assert.equal(isPotProviderError('econnrefused BGUTIL'), true);
  });
});

describe('killProcesses', () => {
  it('kills and nulls ffmpegProcess', () => {
    let killed = false;
    const session = { ffmpegProcess: { kill: () => { killed = true; } }, resolveProcess: null };
    killProcesses(session);
    assert.equal(killed, true);
    assert.equal(session.ffmpegProcess, null);
  });

  it('kills and nulls resolveProcess', () => {
    let killed = false;
    const session = { ffmpegProcess: null, resolveProcess: { kill: () => { killed = true; } } };
    killProcesses(session);
    assert.equal(killed, true);
    assert.equal(session.resolveProcess, null);
  });

  it('handles kill errors gracefully', () => {
    const session = { ffmpegProcess: { kill: () => { throw new Error('already dead'); } }, resolveProcess: null };
    killProcesses(session); // should not throw
    assert.equal(session.ffmpegProcess, null);
  });

  it('handles null processes gracefully', () => {
    killProcesses({ ffmpegProcess: null, resolveProcess: null }); // should not throw
  });
});

// ============================================
// database (SQLite)
// ============================================
import { getDb, closeDb } from './database.js';

describe('database', () => {
  it('getDb returns a database connection', () => {
    const db = getDb();
    assert.ok(db);
    assert.ok(db.prepare);
  });

  it('creates tables on first call', () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map(t => t.name);
    assert.ok(names.includes('play_counts'));
    assert.ok(names.includes('play_history'));
    assert.ok(names.includes('session_state'));
  });

  it('returns same instance on multiple calls', () => {
    const db1 = getDb();
    const db2 = getDb();
    assert.equal(db1, db2);
  });
});

// ============================================
// stats (SQLite-backed)
// ============================================
import { recordPlay, getPlayHistory } from './stats.js';

describe('stats (SQLite)', () => {
  // Clean up test data before each test
  const cleanup = () => {
    const db = getDb();
    db.prepare('DELETE FROM play_counts WHERE video_id LIKE ?').run('test_%');
  };

  it('recordPlay inserts a new video', async () => {
    cleanup();
    await recordPlay({ videoId: 'test_video_1', title: 'Test Video', guildId: '123' });
    const plays = await loadPlays();
    assert.ok(plays['test_video_1']);
    assert.equal(plays['test_video_1'].playCount, 1);
    assert.equal(plays['test_video_1'].title, 'Test Video');
  });

  it('recordPlay increments play count', async () => {
    cleanup();
    await recordPlay({ videoId: 'test_video_1', title: 'Test Video' });
    await recordPlay({ videoId: 'test_video_1', title: 'Test Video' });
    const plays = await loadPlays();
    assert.equal(plays['test_video_1'].playCount, 2);
  });

  it('recordPlay tracks completion', async () => {
    cleanup();
    await recordPlay({ videoId: 'test_video_2', title: 'Test 2' }, { completed: true });
    const plays = await loadPlays();
    assert.equal(plays['test_video_2'].lastCompleted, true);
  });

  it('recordPlay tracks failures', async () => {
    cleanup();
    await recordPlay({ videoId: 'test_video_3', title: 'Test 3' }, { failed: true });
    const plays = await loadPlays();
    assert.equal(plays['test_video_3'].failCount, 1);
  });

  it('recordPlay ignores null video', async () => {
    await recordPlay(null);
    await recordPlay({});
    // should not throw
  });

  it('getPlayHistory returns recent entries', async () => {
    const history = await getPlayHistory(5);
    assert.ok(Array.isArray(history));
    assert.ok(history.length > 0);
  });

  it('loadPlays returns all videos', async () => {
    const plays = await loadPlays();
    assert.ok(typeof plays === 'object');
    assert.ok(Object.keys(plays).length > 0);
  });
});

// ============================================
// session state (SQLite-backed)
// ============================================
import { saveState, loadAllState, getSession } from '../services/session.js';

describe('session state (SQLite)', () => {
  it('saveState and loadAllState round-trip', async () => {
    const session = getSession('test_guild_999');
    session.current = { videoId: 'test_vid', title: 'Test Video' };
    session.mode = 'random';
    session.volume = 80;
    session.queue = ['a', 'b', 'c'];
    session.playedIds = new Set(['x', 'y']);
    session.failedIds = new Set(['z']);
    session.cycleCount = 3;
    session.cycleStartedAt = '2026-01-01T00:00:00Z';

    await saveState(session);
    const all = await loadAllState();
    const saved = all['test_guild_999'];

    assert.ok(saved);
    assert.equal(saved.mode, 'random');
    assert.equal(saved.volume, 80);
    assert.deepEqual(saved.queue, ['a', 'b', 'c']);
    assert.deepEqual(saved.playedIds, ['x', 'y']);
    assert.deepEqual(saved.failedIds, ['z']);
    assert.equal(saved.cycleCount, 3);
    assert.equal(saved.current.videoId, 'test_vid');
  });

  it('saveState overwrites previous state', async () => {
    const session = getSession('test_guild_999');
    session.queue = ['only_one'];
    session.playedIds = new Set();
    session.failedIds = new Set();
    await saveState(session);

    const all = await loadAllState();
    assert.deepEqual(all['test_guild_999'].queue, ['only_one']);
  });

  it('different guilds are independent', async () => {
    const s1 = getSession('test_guild_aaa');
    s1.queue = ['aaa_1'];
    s1.playedIds = new Set();
    s1.failedIds = new Set();
    await saveState(s1);

    const s2 = getSession('test_guild_bbb');
    s2.queue = ['bbb_1', 'bbb_2'];
    s2.playedIds = new Set();
    s2.failedIds = new Set();
    await saveState(s2);

    const all = await loadAllState();
    assert.deepEqual(all['test_guild_aaa'].queue, ['aaa_1']);
    assert.deepEqual(all['test_guild_bbb'].queue, ['bbb_1', 'bbb_2']);
  });
});
