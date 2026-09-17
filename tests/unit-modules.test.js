import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferPlaybackState, selectPublicSession } from '../src/utils/playback-state.ts';
import { validateDiscordInviteUrl } from '../src/utils/discord-invite.js';
import { renderPlaybackState } from '../public/js/playback-view.js';

// ── inferPlaybackState ──
const base = {
  current: { videoId: 'abcdefghijk' },
  continuous: true,
  connection: { state: { status: 'ready', subscription: {} } },
  player: { state: { status: 'playing' } },
};

test('playing requires real audio player state and ready voice connection', () => {
  assert.equal(inferPlaybackState(base), 'playing');
});

test('manual stop wins over everything', () => {
  assert.equal(inferPlaybackState({ ...base, manualStop: true }), 'stopped');
});

test('retained metadata without player reports disconnected (saved session, no live connection)', () => {
  assert.equal(inferPlaybackState({ current: base.current, continuous: true }), 'disconnected');
});

test('no current track means idle', () => {
  assert.equal(inferPlaybackState({ ...base, current: null }), 'idle');
});

test('destroyed or missing connection reports disconnected, not playing', () => {
  assert.equal(inferPlaybackState({ ...base, connection: { state: { status: 'destroyed' } } }), 'disconnected');
  assert.equal(inferPlaybackState({ ...base, connection: null }), 'disconnected');
});

test('connecting voice state reports buffering', () => {
  assert.equal(inferPlaybackState({ ...base, connection: { state: { status: 'connecting' } } }), 'buffering');
});

test('autopaused player reports paused', () => {
  assert.equal(inferPlaybackState({ ...base, player: { state: { status: 'autopaused' } } }), 'paused');
});

test('interjection or foreign subscription reports buffering', () => {
  assert.equal(inferPlaybackState({ ...base, interjecting: true }), 'buffering');
  assert.equal(inferPlaybackState({ ...base, connection: { state: { status: 'ready', subscription: { player: { other: true } } } } }), 'buffering');
});

// ── selectPublicSession ──
test('public selection prefers genuinely playing sessions over titled leftovers', () => {
  const stopped = { title: 'old', playbackState: 'stopped' };
  const playing = { title: 'live', playbackState: 'playing' };
  assert.equal(selectPublicSession([stopped, playing]), playing);
});

test('falls back to paused, buffering, titled, then first', () => {
  const paused = { playbackState: 'paused', title: 'p' };
  assert.equal(selectPublicSession([{ playbackState: 'idle' }, paused]), paused);
  assert.equal(selectPublicSession([{ title: 't', playbackState: 'idle' }]).title, 't');
  assert.equal(selectPublicSession([{ playbackState: 'idle' }]).playbackState, 'idle');
  assert.equal(selectPublicSession([]), null);
});

// ── validateDiscordInviteUrl ──
test('accepts only https discord.gg / discord.com invites', () => {
  assert.equal(validateDiscordInviteUrl('https://discord.gg/ab3_xZ-9'), 'https://discord.gg/ab3_xZ-9');
  assert.equal(validateDiscordInviteUrl('https://discord.com/invite/ab3_xZ-9'), 'https://discord.com/invite/ab3_xZ-9');
  assert.equal(validateDiscordInviteUrl('http://discord.gg/abc'), undefined, 'no http');
  assert.equal(validateDiscordInviteUrl('https://evil.test/invite/abc'), undefined, 'no other hosts');
  assert.equal(validateDiscordInviteUrl('https://user:pass@discord.gg/abc'), undefined, 'no credentials');
  assert.equal(validateDiscordInviteUrl('https://discord.gg/abc/../../evil'), undefined, 'no traversal');
  assert.equal(validateDiscordInviteUrl('javascript:alert(1)'), undefined);
  assert.equal(validateDiscordInviteUrl(''), undefined);
  assert.equal(validateDiscordInviteUrl(null), undefined);
  assert.equal(validateDiscordInviteUrl(42), undefined);
});

// ── renderPlaybackState ──
function fakeDoc() {
  const bars = Array.from({ length: 5 }, () => ({ className: '', classList: {
    toggle(name, on) { this._set(name, on); },
    _set: {}, _set(name, on) { this[name] = on; },
    contains(name) { return !!this[name]; },
  } }));
  const els = {
    npTag: { textContent: '' },
    npFill: { style: {} },
    npElapsed: { textContent: '9:99' },
  };
  return {
    getElementById: id => els[id] || null,
    querySelectorAll: sel => sel === '.np-vis span' ? bars : [],
    bars,
    els,
  };
}

test('renderer stops the clock and freezes bars when playback is stopped', () => {
  const doc = fakeDoc();
  const playing = renderPlaybackState(doc, { playbackState: 'playing', elapsedSeconds: 30, durationSeconds: 100 });
  assert.equal(playing, true);
  assert.match(doc.els.npTag.textContent, /على الهواء/);
  assert.equal(doc.els.npFill.style.width, '30%');

  const stopped = renderPlaybackState(doc, { playbackState: 'stopped', elapsedSeconds: 30, durationSeconds: 100 });
  assert.equal(stopped, false);
  assert.match(doc.els.npTag.textContent, /متوقف/);
  assert.equal(doc.els.npFill.style.width, '0%');
  assert.equal(doc.els.npElapsed.textContent, '0:00');
  assert.ok(doc.bars.every(b => b.classList.contains('off')), 'bars off when stopped');
});

test('renderer falls back honestly when backend sends no state', () => {
  const doc = fakeDoc();
  const result = renderPlaybackState(doc, { elapsedSeconds: 5, durationSeconds: 10 });
  assert.equal(result, false, 'unknown state must never look playable');
  assert.match(doc.els.npTag.textContent, /غير مؤكدة/);
});
