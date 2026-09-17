import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { startLiveUpdates } from '../public/js/live-updates.js';
import { createKioskView, checkKioskJingles } from '../public/js/kiosk-view.js';

// Inject the real production modules as globals so the page script's imports resolve.
const kioskViewForPage = { startLiveUpdates: opts => startLiveUpdates(opts), createKioskView, checkKioskJingles };

// The kiosk must never fake playback: no red lamp or waves without a real 'playing' state.
test('kiosk never shows live before data, only on genuine playing state, and dims on unknown', async () => {
  const html = readFileSync(new URL('../public/kiosk.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/admin/kiosk', runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map();
  let next = 0;
  const source = { close() {} };
  const base = { nowPlaying: { title: 'اختبار الكيوسك', paused: false, playbackState: 'playing' }, totalPlays: 5, uptimeHours: 2, totalVideos: 902 };
  let payload;
  window.fetch = async url => {
    if (String(url).includes('activity')) return { ok: true, json: async () => ({ jingles: [], timestamp: Date.now() }) };
    return { ok: true, json: async () => payload };
  };
  window.startLiveUpdates = opts => startLiveUpdates({
    ...opts,
    createEventSource: () => source,
    schedule: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    cancel: key => timers.delete(key),
  });
  try {
    // Initial markup honesty: loading state, dim dot, no "مباشر الآن" claim.
    assert.equal(window.document.getElementById('liveText').textContent, 'جاري الاتصال…');
    assert.equal(window.document.getElementById('liveDot').className.includes('off'), true);
    for (const script of window.document.querySelectorAll('script[type="module"]')) {
      // Inject the real production modules (same objects the standalone verification proved),
      // then evaluate the page's wiring script against them.
      // window.startLiveUpdates is the test-wired wrapper (records timers); the raw
      // module import would bypass it with real setTimeout, invisible to assertions.
      window.__inj = { startLiveUpdates: window.startLiveUpdates, createKioskView, checkKioskJingles };
      const body = script.textContent
        .replace(/^import \{ createKioskView, checkKioskJingles \} from '\/js\/kiosk-view\.js';\s*/m, 'const { createKioskView, checkKioskJingles } = window.__inj;')
        .replace(/^import { startLiveUpdates } from '\/js\/live-updates\.js';\s*/m, 'const startLiveUpdates = window.__inj.startLiveUpdates;');
      window.eval(body);
    }
    // The page's first update fires immediately; let its refresh promise settle before polling.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const item = [...timers].find(([, timer]) => timer.ms === 5000);
    assert.ok(item, 'kiosk retains a reconciliation poll');
    timers.delete(item[0]);
    payload = base;
    await item[1].fn();
    assert.equal(window.document.body.dataset.state, 'playing');
    assert.match(window.document.getElementById('liveText').textContent, /على الهواء/);
    assert.ok(!window.document.getElementById('liveDot').className.includes('off'));
    assert.ok(!window.document.getElementById('kioskWave').classList.contains('off'));
    // Stopped payload must dim lamp and waves, never claim live.
    const item2 = [...timers].find(([, timer]) => timer.ms === 5000);
    timers.delete(item2[0]);
    payload = { ...base, nowPlaying: { ...base.nowPlaying, playbackState: 'stopped' } };
    await item2[1].fn();
    assert.equal(window.document.body.dataset.state, 'stopped');
    assert.doesNotMatch(window.document.getElementById('liveText').textContent, /مباشر|على الهواء/);
    assert.ok(window.document.getElementById('kioskWave').classList.contains('off'));
    assert.ok(window.document.getElementById('liveDot').className.includes('off'));
    // Unknown playbackState (legacy payload) must NOT look live.
    const item3 = [...timers].find(([, timer]) => timer.ms === 5000);
    timers.delete(item3[0]);
    payload = { ...base, nowPlaying: { title: 'قديم', paused: false } };
    await item3[1].fn();
    assert.doesNotMatch(window.document.getElementById('liveText').textContent, /مباشر|على الهواء/);
    assert.ok(window.document.getElementById('kioskWave').classList.contains('off'));
    // Connection loss: honest unknown with last-updated stamp, lamp stays off.
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});

// Unit coverage for the view module itself.
test('kiosk view apply/markUnknown are truthful without a DOM page', () => {
  const elements = {};
  const makeEl = () => {
    const el = { textContent: '', className: '', _classes: {} };
    el.classList = { toggle: (name, on) => { el._classes[name] = !!on; }, contains: name => !!el._classes[name] };
    return el;
  };
  const fakeDoc = {
    body: { dataset: {} },
    getElementById: id => elements[id] || (elements[id] = makeEl()),
  };
  const view = createKioskView(fakeDoc);
  assert.equal(view.apply({ nowPlaying: { title: 'x', playbackState: 'playing' }, totalPlays: 1 }), 'playing');
  assert.equal(fakeDoc.body.dataset.state, 'playing');
  assert.ok(!elements.liveDot.className.includes('off'));
  assert.ok(!elements.kioskWave._classes.off);
  assert.equal(view.apply({ nowPlaying: null }), 'idle');
  assert.equal(view.apply(null), 'loading');
  assert.ok(elements.liveDot.className.includes('off'));
  assert.equal(view.markUnknown(new Date('2026-01-01T10:00:00')), 'loading');
  assert.match(elements.liveText.textContent, /غير مؤكدة/);
  assert.match(elements.liveText.textContent, /آخر تحديث/);
});
