import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderPlaybackState } from '../public/js/playback-view.js';

test('dashboard stop action posts to command endpoint and renders stopped backend state', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const requests = [];
  let playbackState = 'playing';
  window.requestAnimationFrame = () => 0;
  window.setInterval = () => 0;
  window.EventSource = undefined;
  window.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    const json = data => ({ ok: true, status: 200, json: async () => data });
    if (url === '/api/command') {
      assert.equal(JSON.parse(options.body).command, 'stop');
      playbackState = 'stopped';
      return json({ ok: true });
    }
    if (url === '/api/status') return json({
      uptime: 60, memMB: 10, sessions: [{
        guildId: 'test-guild', guildName: 'Test station', title: 'Retained track after stop',
        videoId: 'abcdefghijk', elapsedSeconds: 12, durationSeconds: 120,
        paused: false, connected: playbackState === 'playing', playbackState,
        queue: [],
      }],
    });
    return json({});
  };
  try {
    for (const script of window.document.querySelectorAll('script:not([src])')) {
      const expose = script.textContent.includes('const refresh =') ? '\nwindow.testRefresh = refresh; window.testCommand = cmd;' : '';
      window.testPlaybackView = { renderPlaybackState };
      window.eval(script.textContent.replace("import('/js/playback-view.js')", 'Promise.resolve(window.testPlaybackView)') + expose);
    }
    window.sessionStorage.setItem('dashboard_token', 'test-only-token');
    await window.testRefresh();
    assert.ok([...window.document.querySelectorAll('.np-vis span')].some(el => !el.classList.contains('off')));
    await window.testCommand('stop');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(requests.some(r => r.url === '/api/command' && r.options.method === 'POST'));
    const label = window.document.getElementById('npTag').textContent;
    assert.match(label, /متوقف/, 'The visible player label must explicitly report stopped');
    assert.doesNotMatch(label, /مباشر|playing|live/i);
    assert.ok([...window.document.querySelectorAll('.np-vis span')].every(el => el.classList.contains('off')), 'Stopped playback must not animate the audio indicator');
  } finally {
    window.close();
  }
});
