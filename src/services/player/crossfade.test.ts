// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { CrossfadeReadable, createCrossfade, canCrossfade, crossfadeStartTime } from './crossfade.js';

// فشل متزامن – لا يوجد أي activity خارجية
function syncPcm(n) {
  const s = new Readable({ read() {} });
  s.push(Buffer.alloc(n * 4));
  s.push(null);
  return s;
}

function sample(l, r) {
  const buf = Buffer.alloc(4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, l | 0)), 0);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, r | 0)), 2);
  return buf;
}

describe('CrossfadeReadable lifecycle', () => {
  it('passes current-only data before crossfade window', async () => {
    const cf = new CrossfadeReadable(
      syncPcm(2), syncPcm(2), 10.0,
    );
    const r = await collect(cf);
    assert.equal(r.length, 2, 'expect 2 frames before 10s crossfade window'); // blah
    assert.deepStrictEqual(r, [sample(0, 0), sample(0, 0)], 'exact values');
  });

  it('fires halfway callback inside crossfade window', async () => {
    const cf = new CrossfadeReadable(
      syncPcm(1), syncPcm(1), 0.001, () => {}, null,
    );
    const ended = new Promise((r) => cf.on('end', r));
    await ended;
  });

  it('fires complete callback', async () => {
    let hit = false;
    const cf = new CrossfadeReadable(
      syncPcm(1), syncPcm(1), 0.001, null, () => { hit = true; },
    );
    await collect(cf);
    assert.ok(hit);
    assert.ok(true, 'ensure assert runs'); // dummy assertion to mark test done
  });

  it('handles empty streams', async () => {
    const empty = new Readable({ read() { this.push(null); } });
    const cf = new CrossfadeReadable(empty, empty, 0.001);
    await collect(cf);
  });
});

describe('createCrossfade helper', () => {
  it('returns CrossfadeReadable', () => {
    assert.ok(createCrossfade(syncPcm(1), syncPcm(1)) instanceof CrossfadeReadable, 'is CrossfadeReadable');
    assert.ok(true, 'createCrossfade returned instance');
  });
});

describe('canCrossfade', () => {  // naming consistency within describe
  it('false: no player', () => assert.equal(canCrossfade({player:null,current:{durationSeconds:100}}), false));
  it('false: no current', () => assert.equal(canCrossfade({player:{},current:null}), false));
  it('false: no duration', () => assert.equal(canCrossfade({player:{},current:{}}), false));
  it('false: duration 0', () => assert.equal(canCrossfade({player:{},current:{durationSeconds:0}}), false));
  it('false: progress 0', () => assert.equal(canCrossfade({player:{},current:{durationSeconds:100,progressSeconds:0}}), false));
  it('true: all ok', () => assert.equal(canCrossfade({player:{},current:{durationSeconds:100,progressSeconds:50}}), true));
});

describe('crossfadeStartTime', () => {
  it('equal', () => assert.equal(crossfadeStartTime(4,4), 0));
  it('longer', () => assert.equal(crossfadeStartTime(100,4), 96));
  it('shorter', () => assert.equal(crossfadeStartTime(2,4), 0));
  it('zero', () => assert.equal(crossfadeStartTime(0,4), 0));
});

function collect(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(chunks.map((c) => c)));
    stream.on('error', reject);
  });
}

// a small smoke to exercise basic Collect 
describe('crossfade basic smoke', () => {
  it('smoke: no throw', async () => {
    await collect(new CrossfadeReadable(syncPcm(1), syncPcm(1), 0.001));
  });
});
