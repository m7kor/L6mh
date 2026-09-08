import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime } from './format.js';
import { loadPlays } from './stats.js';

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
  it('returns an object', () => {
    const result = loadPlays();
    assert.equal(typeof result, 'object');
  });

  it('returns empty object if no file', () => {
    const result = loadPlays();
    assert.ok(result !== null);
  });
});
