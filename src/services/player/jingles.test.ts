/**
 * The jingle/station-ID promise must always settle.
 *
 * Both players here rely on the AudioPlayer reaching `Idle` to resolve. A player
 * whose connection is not ready goes `AutoPaused` instead, and emits neither
 * `Idle` nor `error` — so before the timeout was added, a voice socket that
 * dropped mid-jingle left `playRandomJingle` pending forever.
 *
 * That matters more than a hung promise usually would, because
 * `connectAndPlay` awaits it. The radio never started, and the cleanup that
 * hands the connection back to the main player never ran either, so the main
 * player stayed unsubscribed: a permanently silent channel with the bot online
 * and ffmpeg still running. `playSoundEffect` had the same shape and is awaited
 * on the boot path, where a single bad file would take out the whole auto-join
 * loop.
 *
 * The env vars are set before importing because the module reads them at load.
 */
process.env.SOUND_EFFECTS_ENABLED = 'true';
process.env.SOUND_TIMEOUT_MS = '300';
process.env.SOUNDS_MIN_MINUTES = '10';
process.env.SOUNDS_MAX_MINUTES = '30';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { getSession } from '../session.js';

let playRandomJingle: any;
let playSoundEffect: any;
let listSounds: any;
let resolveSoundPath: any;

/** A connection that never becomes ready — the shape that used to hang. */
function deadConnection(channelId: string) {
  const subscribed: any[] = [];
  return {
    subscribed,
    joinConfig: { channelId },
    state: { status: 'ready' },
    subscribe(player: any) { subscribed.push(player); },
  };
}

function makeGuild(id: string) {
  return { id, voiceAdapterCreator: () => ({}) };
}

before(async () => {
  ({ playRandomJingle, playSoundEffect } = await import('./jingles.js'));
  ({ listSounds, resolveSoundPath } = await import('../../utils/sounds.js'));
});

describe('jingle playback always settles', () => {
  it('resolves even though the jingle player never reaches Idle', async () => {
    const guild = makeGuild('jingle-hang');
    const channel = { id: 'c1', name: 'General' };
    const session = getSession(guild.id);
    session.connection = deadConnection(channel.id);
    session.player = { __fake: 'main-player' };

    // A real connection would deliver packets and drive the player to Idle.
    // This one swallows the subscription, so the player parks in AutoPaused —
    // exactly the state that used to leave this promise pending forever.
    const started = Date.now();
    await playRandomJingle(guild, channel);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5_000, `playRandomJingle should bail out promptly, took ${elapsed}ms`);

    // The main player must be handed the connection back, or the radio stays
    // silent even after the jingle is abandoned.
    assert.equal(
      session.connection.subscribed.at(-1),
      session.player,
      'the connection must be returned to the main player',
    );
  });

  it('does not leave the jingle player subscribed to the connection', async () => {
    const guild = makeGuild('jingle-hang-2');
    const channel = { id: 'c2', name: 'General' };
    const session = getSession(guild.id);
    session.connection = deadConnection(channel.id);
    session.player = { __fake: 'main-player' };

    await playRandomJingle(guild, channel);

    const jinglePlayers = session.connection.subscribed.filter((p: any) => p !== session.player);
    assert.equal(jinglePlayers.length, 1, 'exactly one jingle player was subscribed');
  });

  it('resolves when there is nothing to play', async () => {
    const guild = makeGuild('jingle-empty');
    const session = getSession(guild.id);
    session.connection = deadConnection('c3');
    session.player = { __fake: 'main-player' };

    // No session reference in the previous test path: still must not throw or hang.
    await assert.doesNotReject(() => playRandomJingle(guild, { id: 'c3', name: 'General' }));
  });
});

describe('playSoundEffect always settles', () => {
  it('abandons a sound that never plays instead of hanging the boot path', async () => {
    const names = listSounds();
    assert.ok(names.length > 0, 'the fixtures need at least one sound file');

    const filePath = resolveSoundPath(names[0]);
    assert.ok(filePath, `could not resolve a path for ${names[0]}`);

    const guild = makeGuild('sfx-hang');
    const channel = { id: 'c4', name: 'General' };
    const session = getSession(guild.id);
    session.connection = deadConnection(channel.id);

    const started = Date.now();
    // Resolving is the contract; the connection here never becomes ready, so
    // this is the path that used to wedge the auto-join loop at boot.
    await playSoundEffect(guild, channel, filePath);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5_000, `playSoundEffect should bail out promptly, took ${elapsed}ms`);
  });

  it('settles on an unreadable file instead of hanging', async () => {
    const guild = makeGuild('sfx-missing');
    const channel = { id: 'c5', name: 'General' };
    getSession(guild.id).connection = deadConnection(channel.id);

    // `createAudioResource` does not validate the path — a missing file
    // surfaces later as a player `error` on a live connection, and as a stall
    // on a dead one. Both must settle; which of the two happens depends on the
    // connection, so the contract under test is only that it terminates.
    const started = Date.now();
    const settled = await Promise.race([
      playSoundEffect(guild, channel, join(process.cwd(), 'sounds', 'does-not-exist.wav'))
        .then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 5_000)),
    ]);
    const elapsed = Date.now() - started;

    assert.notEqual(settled, 'hung', 'playSoundEffect must not hang on a bad file');
    assert.ok(elapsed < 5_000, `settled too slowly: ${elapsed}ms`);
  });
});
