import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLiveUpdates } from './live-updates.js';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function setup(refresh, options = {}) {
  const timers = new Map();
  const states = [];
  let id = 0;
  const source = { closed: false, close() { this.closed = true; } };
  const updates = startLiveUpdates({
    refresh,
    onConnectionChange: value => states.push(value),
    createEventSource: () => source,
    schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    cancel: key => timers.delete(key),
    ...options,
  });
  async function tick(ms) {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `Expected a ${ms}ms timer`);
    timers.delete(entry[0]);
    await entry[1].fn();
    await flush();
  }
  return { updates, source, timers, states, tick };
}

test('SSE messages never overlap an in-flight request', async () => {
  let calls = 0;
  let finish;
  const h = setup(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  h.source.onmessage();
  h.source.onmessage();
  assert.equal(calls, 1);
  finish();
  await flush();
  assert.deepEqual(h.states, [true]);
  assert.equal(h.timers.size, 1);
  h.updates.stop();
});

test('polling continues with SSE and maintains only one scheduled poll', async () => {
  let calls = 0;
  const h = setup(async () => { calls++; });
  await flush();
  await h.tick(5000);
  assert.equal(calls, 2);
  await h.source.onmessage();
  assert.equal(calls, 3);
  assert.equal(h.timers.size, 1);
  await h.tick(5000);
  assert.equal(calls, 4);
  h.updates.stop();
});

test('failed refresh reports stale data and next poll restores connection', async () => {
  let calls = 0;
  const h = setup(async () => { if (++calls === 1) throw new Error('offline'); });
  await flush();
  assert.deepEqual(h.states, [false]);
  await h.tick(5000);
  assert.deepEqual(h.states, [false, true]);
  h.updates.stop();
});

test('unsupported SSE falls back to polling', async () => {
  const h = setup(async () => {}, { createEventSource: () => { throw new Error('unsupported'); } });
  await flush();
  await h.tick(5000);
  assert.deepEqual(h.states, [true, true]);
  h.updates.stop();
});

test('request timeout aborts fetch and schedules recovery', async () => {
  const h = setup(signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }));
  await h.tick(8000);
  assert.deepEqual(h.states, [false]);
  assert.equal(h.timers.size, 1);
  h.updates.stop();
});

test('stop aborts pending work, closes SSE and prevents further updates', async () => {
  let signal;
  let finish;
  const h = setup(s => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  h.updates.stop();
  assert.equal(signal.aborted, true);
  assert.equal(h.source.closed, true);
  finish();
  await flush();
  await h.updates.refresh();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.states, []);
});
