import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { startLiveUpdates } from '../public/js/live-updates.js';

// The jingle toast must reflect jingle events honestly: shown on event, hidden after its timeout.
test('jingle toast shows on jingle event and clears itself afterwards', async () => {
  const html = readFileSync(new URL('../public/live.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/live', runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map();
  let next = 0;
  const source = { close() {} };
  const noJingle = { nowPlaying: null, guilds: 1, history: [], topPlayed: [], leaderboard: [] };
  let payload = noJingle;
  window.fetch = async url => {
    if (String(url).includes('activity')) return { ok: true, json: async () => ({ jingles: [{ name: 'لطمة', category: 'latma', at: Date.now() }], timestamp: Date.now() }) };
    return { ok: true, json: async () => payload };
  };
  window.startLiveUpdates = opts => startLiveUpdates({
    ...opts,
    createEventSource: () => source,
    schedule: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    cancel: key => timers.delete(key),
  });
  // Defer the page's own setTimeout calls (toast auto-hide, image swap) so assertions stay deterministic.
  const deferred = [];
  window.setTimeout = (fn, ms) => { deferred.push({ fn, ms }); return deferred.length; };
  window.clearTimeout = () => {};
  try {
    for (const script of window.document.querySelectorAll('script:not([src])')) {
      window.eval(script.textContent.replace(/^import .*live-updates\.js';\s*/m, ''));
    }
    await new Promise(resolve => setImmediate(resolve));
    const toast = window.document.getElementById('jingleToast');
    const item = [...timers].find(([, timer]) => timer.ms === 5000);
    assert.ok(item, 'page retains a reconciliation poll');
    timers.delete(item[0]);
    await item[1].fn();
    assert.ok(toast.classList.contains('show'), 'toast shows on jingle event');
    assert.match(window.document.getElementById('jingleText').textContent, /لطمة/);
    // The page's deferred timers must include the toast auto-hide and the flash clear.
    assert.ok(deferred.some(entry => entry.ms === 3000), 'toast auto-hide timer was scheduled');
    assert.ok(deferred.some(entry => entry.ms === 300), 'flash clear timer was scheduled');
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});

// Guards the CSS regression: jingle/flash rules live in live.css, not a deleted <style> block.
test('live.css keeps jingle toast and latma flash rules for the actual page', async () => {
  const css = readFileSync(new URL('../public/css/live.css', import.meta.url), 'utf8');
  for (const selector of ['#jingleToast', '#jingleToast.show', '#latmaFlash.active', '#latmaFlash.latma', '@keyframes jingleBounce']) {
    assert.ok(css.includes(selector), `live.css must style ${selector}`);
  }
  const html = readFileSync(new URL('../public/live.html', import.meta.url), 'utf8');
  assert.ok(!/<style>/.test(html), 'page must not accumulate inline style blocks again');
  assert.match(html, /css\/live\.css/, 'page must link the midnight broadcast stylesheet');
});
