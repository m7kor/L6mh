import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { startLiveUpdates } from '../public/js/live-updates.js';

// Exercise the actual page's classic scripts and module wiring, not a duplicated renderer.
test('public page reports stale status after fetch failure and recovers on next poll', async () => {
  const html = readFileSync(new URL('../public/live.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/live', runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map();
  let next = 0;
  let online = true;
  const source = { close() {} };
  const snapshot = {
    nowPlaying: { title: 'اختبار البث', videoId: 'abcdefghijk', paused: false, playbackState: 'playing', elapsed: 12, duration: 120 },
    totalPlays: 1, guilds: 1, history: [], topPlayed: [], leaderboard: [],
  };
  window.fetch = async url => {
    if (String(url).includes('activity')) return { ok: true, json: async () => ({ jingles: [] }) };
    if (!online) return { ok: false, status: 503 };
    return { ok: true, json: async () => snapshot };
  };
  window.startLiveUpdates = opts => startLiveUpdates({
    ...opts,
    createEventSource: () => source,
    schedule: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    cancel: key => timers.delete(key),
  });
  try {
    for (const script of window.document.querySelectorAll('script:not([src])')) {
      window.eval(script.textContent.replace(/^import .*live-updates\.js';\s*/m, ''));
    }
    await new Promise(resolve => setImmediate(resolve));
    const text = id => window.document.getElementById(id).textContent;
    assert.match(text('npTitle'), /اختبار البث/);
    assert.match(text('liveBadge'), /مباشر|على الهواء/);
    assert.equal(text('connectionNotice'), '');
    async function poll() {
      const item = [...timers].find(([, timer]) => timer.ms === 5000);
      assert.ok(item, 'page retains a reconciliation poll');
      timers.delete(item[0]);
      await item[1].fn();
    }
    online = false;
    await poll();
    assert.match(text('connectionNotice'), /تعذّر|تعذر/);
    assert.doesNotMatch(text('liveBadge'), /مباشر الآن|على الهواء/);
    assert.ok(window.document.getElementById('npWave').classList.contains('off'));
    online = true;
    await poll();
    assert.equal(text('connectionNotice'), '');
    assert.match(text('liveBadge'), /مباشر|على الهواء/);
    assert.ok(!window.document.getElementById('npWave').classList.contains('off'));
    assert.equal(window.document.getElementById('hero').dataset.state, 'playing', 'on-air lamp lights only for genuine playback');
    assert.match(text('onairText'), /على الهواء/);
    snapshot.nowPlaying.playbackState = 'stopped';
    await poll();
    assert.doesNotMatch(text('liveBadge'), /مباشر الآن|على الهواء/, 'stopped must never show as live');
    assert.ok(window.document.getElementById('npWave').classList.add ? window.document.getElementById('npWave').classList.contains('off') : false, 'stopped must not animate waves');
    delete snapshot.nowPlaying.playbackState;
    snapshot.nowPlaying.paused = false;
    await poll();
    assert.doesNotMatch(text('liveBadge'), /مباشر الآن|على الهواء/, 'unknown state must never show as live');
    assert.notEqual(window.document.getElementById('hero').dataset.state, 'playing', 'lamp must dim on unknown state');
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});

test('join CTA only appears with a backend-validated invite and never fabricates one', async () => {
  const html = readFileSync(new URL('../public/live.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/live', runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map();
  let next = 0;
  const source = { close() {} };
  const base = {
    nowPlaying: { title: 'اختبار البث', videoId: 'abcdefghijk', paused: false, playbackState: 'playing', elapsed: 12, duration: 120 },
    totalPlays: 1, guilds: 1, history: [], topPlayed: [], leaderboard: [],
  };
  let payload = { ...base };
  window.fetch = async url => {
    if (String(url).includes('activity')) return { ok: true, json: async () => ({ jingles: [] }) };
    return { ok: true, json: async () => payload };
  };
  window.startLiveUpdates = opts => startLiveUpdates({
    ...opts,
    createEventSource: () => source,
    schedule: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    cancel: key => timers.delete(key),
  });
  try {
    for (const script of window.document.querySelectorAll('script:not([src])')) {
      window.eval(script.textContent.replace(/^import .*live-updates\.js';\s*/m, ''));
    }
    await new Promise(resolve => setImmediate(resolve));
    const cta = window.document.getElementById('joinCta');
    assert.equal(cta.hidden, true, 'no fabricated listen button without a validated invite');
    assert.ok(!cta.getAttribute('href') || cta.getAttribute('href') === '#');
    const item = [...timers].find(([, timer]) => timer.ms === 5000);
    timers.delete(item[0]);
    payload = { ...base, discordInviteUrl: 'https://discord.gg/ab3_xZ-9' };
    await item[1].fn();
    assert.equal(cta.hidden, false);
    assert.equal(cta.href, 'https://discord.gg/ab3_xZ-9');
    assert.equal(cta.rel.includes('noopener'), true);
    const item2 = [...timers].find(([, timer]) => timer.ms === 5000);
    timers.delete(item2[0]);
    payload = { ...base };
    await item2[1].fn();
    assert.equal(cta.hidden, true, 'CTA hides when the station sends no invite');
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});
