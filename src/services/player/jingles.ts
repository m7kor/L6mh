/**
 * jingles.js — إدارة المؤثرات الصوتية والفواصل بين المقاطع.
 *
 * يعتمد على خوارزمية "أقل-ما-شُغِّل-مؤخراً" لاختيار الجينغل
 * لضمان التوزيع العادل بين المؤثرات المتاحة.
 */

import { createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { createLogger } from '../../utils/logger.js';
import { listSounds, resolveSoundPath } from '../../utils/sounds.js';
import { getSession } from '../session.js';

const logger = createLogger('audio');

const SOUNDS_ENABLED   = (process.env.SOUND_EFFECTS_ENABLED   || 'false') === 'true';
const SOUNDS_MIN_MS    = Number(process.env.SOUND_EFFECTS_MIN_MINUTES || 10) * 60_000;
const SOUNDS_MAX_MS    = Number(process.env.SOUND_EFFECTS_MAX_MINUTES || 30) * 60_000;
/**
 * How long a local sound may run before it is abandoned.
 *
 * Both players here rely on `Idle` to settle. An AudioPlayer that is
 * `AutoPaused` because the connection is not ready never reaches `Idle`, and
 * nothing else settles the promise — so a dropped voice socket mid-jingle
 * would hang `connectAndPlay` for good, and the cleanup that hands the
 * connection back to the radio would never run either.
 */
const SOUND_TIMEOUT_MS = Number(process.env.SOUND_TIMEOUT_MS || 30_000);
/** Per-guild bookkeeping older than this is dropped by the sweep. */
const JINGLE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** آخر وقت شُغِّل فيه كل مؤثر (لحساب الأوزان). */
const jingleLastPlayed  = new Map();
/** الوقت الأدنى المسموح للمؤثر التالي (per-guild). */
const nextAllowedJingle = new Map();

// ---------------------------------------------------------------------------
// Activity: jingle event buffer — last 10 events, read by activity server
// ---------------------------------------------------------------------------

const jingleEventBuffer = [];
const MAX_JINGLE_EVENTS = 10;

/**
 * @returns {{ name: string, category: string, at: number, guildId: string }[]}
 * Read all buffered jingle events without consuming them.
 */
export function peekJingleEvents() {
  return [...jingleEventBuffer];
}

// ---------------------------------------------------------------------------
// اختيار الجينغل — ترجيح بالعمر (الأقدم يحظى بفرصة أكبر)
// ---------------------------------------------------------------------------

export function pickJingle(sounds) {
  if (sounds.length === 0) return null;
  if (sounds.length === 1) return sounds[0];

  const now = Date.now();
  const weights = sounds.map((name) => {
    const last = jingleLastPlayed.get(name) || 0;
    return Math.max(1, (now - last) / 60_000);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < sounds.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      jingleLastPlayed.set(sounds[i], now);
      return sounds[i];
    }
  }
  const fallback = sounds[sounds.length - 1];
  jingleLastPlayed.set(fallback, now);
  return fallback;
}

// ---------------------------------------------------------------------------
// تشغيل مؤثر صوتي محلي (يُستخدم عند الدخول أو بين المقاطع)
// ---------------------------------------------------------------------------

/**
 * Play a local sound file over the guild's voice connection.
 *
 * Always settles: an unreachable channel, an unreadable file, a player error
 * and a player that never reaches `Idle` all resolve or reject rather than
 * hanging the caller. This is awaited on the boot path, so a promise that never
 * settles would take the whole auto-join loop down with it.
 */
export function playSoundEffect(guild, channel, filePath) {
  const session = getSession(guild.id);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer = null;
    let effectPlayer = null;

    const finish = (err = null) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (effectPlayer) {
        try { effectPlayer.stop(true); } catch { /* already gone */ }
        effectPlayer = null;
      }
      if (err) reject(err); else resolve();
    };

    // Backstop for every path below, including an AudioPlayer that goes
    // AutoPaused on a connection that never becomes Ready.
    timer = setTimeout(() => {
      logger.warn(`[${guild.id}] Sound effect timed out after ${SOUND_TIMEOUT_MS / 1000}s`);
      finish();
    }, SOUND_TIMEOUT_MS);

    const alreadyHere = session.connection
      && session.connection.joinConfig.channelId === channel.id
      && session.connection.state.status !== VoiceConnectionStatus.Destroyed;

    if (!alreadyHere) {
      if (session.connection) { try { session.connection.destroy(); } catch {} }
      session.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      entersState(session.connection, VoiceConnectionStatus.Ready, 30_000)
        .then(() => { if (!settled) playFile(session.connection); })
        .catch((err) => finish(new Error(`تعذّر الاتصال بالقناة الصوتية: ${err.message}`)));
    } else {
      playFile(session.connection);
    }

    function playFile(conn) {
      if (settled) return;
      effectPlayer = createAudioPlayer();
      let resource;
      try {
        resource = createAudioResource(filePath);
      } catch (err) {
        finish(new Error(`تعذّر تشغيل الملف الصوتي: ${err.message}`));
        return;
      }
      effectPlayer.on('error', (err) => {
        logger.error(`[${guild.id}] Sound effect error:`, err.message);
        finish(err);
      });
      effectPlayer.on(AudioPlayerStatus.Idle, () => finish());
      conn.subscribe(effectPlayer);
      effectPlayer.play(resource);
    }
  });
}

// ---------------------------------------------------------------------------
// Station ID — يُشغّل كل 30د لإعلان استمرار البث
// ---------------------------------------------------------------------------

const STATION_ID_INTERVAL_MS = 30 * 60 * 1000;
const lastStationIdAt = new Map();

export function playStationId(guild, channel) {
  const now = Date.now();
  const last = lastStationIdAt.get(guild.id) || 0;
  if (now - last < STATION_ID_INTERVAL_MS) return false;

  const sounds = listSounds();
  const candidate = sounds.find((s) => s.toLowerCase().includes('station-id'));
  if (!candidate) return false;

  const path = resolveSoundPath(candidate);
  if (!path) return false;

  lastStationIdAt.set(guild.id, now);
  playSoundEffect(guild, channel, path).catch((err) =>
    logger.warn(`[jingles] station-ID failed: ${err.message}`),
  );
  return true;
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').VoiceChannel} channel
 */
export async function playRandomJingle(guild, channel) {
  if (!SOUNDS_ENABLED) return;
  const session = getSession(guild.id);
  const allowed = nextAllowedJingle.get(guild.id) || 0;
  if (Date.now() < allowed) return;

  try {
    const sounds = listSounds();
    if (sounds.length === 0) return;

    const name     = pickJingle(sounds);
    const filePath = resolveSoundPath(name);
    if (!filePath) return;

    const alreadyHere = session.connection
      && session.connection.joinConfig.channelId === channel.id
      && session.connection.state.status !== VoiceConnectionStatus.Destroyed;
    if (!alreadyHere) return;

    const mainPlayer = session.player;
    if (!mainPlayer) return;

    logger.info(`[${guild.id}] Jingle: ${name}`);

    await new Promise<void>((resolve) => {
      const jinglePlayer = createAudioPlayer();
      let resource;
      try {
        resource = createAudioResource(filePath);
      } catch {
        resolve();
        return;
      }

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Hand the connection back to the radio no matter how this ended. If
        // the jingle is abandoned rather than finished, this is the only thing
        // that stops the main player sitting unsubscribed and the radio going
        // quiet.
        try { session.connection?.subscribe(mainPlayer); } catch {}
        try { jinglePlayer.stop(true); } catch { /* already gone */ }
        resolve();
      };

      // Without this the promise can never settle: a player that is
      // AutoPaused on a connection that never becomes Ready emits neither
      // `Idle` nor `error`, and `connectAndPlay` is waiting on it.
      const timer = setTimeout(() => {
        logger.warn(`[${guild.id}] Jingle "${name}" did not finish — skipping it.`);
        finish();
      }, SOUND_TIMEOUT_MS);

      jinglePlayer.on('error', (err) => {
        logger.warn(`[${guild.id}] Jingle player error: ${err?.message}`);
        finish();
      });
      jinglePlayer.on(AudioPlayerStatus.Idle, finish);
      session.connection.subscribe(jinglePlayer);
      jinglePlayer.play(resource);
    });

    // Emit jingle event for Activity overlay
    const category = name.includes('latma') ? 'latma' : name.includes('basmala') ? 'basmala' : 'general';
    jingleEventBuffer.push({ name, category, at: Date.now(), guildId: guild.id });
    if (jingleEventBuffer.length > MAX_JINGLE_EVENTS) jingleEventBuffer.shift();

    const interval = SOUNDS_MIN_MS + Math.random() * (SOUNDS_MAX_MS - SOUNDS_MIN_MS);
    nextAllowedJingle.set(guild.id, Date.now() + interval);
  } catch (err) {
    logger.warn(`[${guild.id}] Jingle failed:`, err.message);
  }
}

/**
 * Drop per-guild bookkeeping for servers the bot is no longer in.
 *
 * `nextAllowedJingle` and `lastStationIdAt` are keyed by guild id and are only
 * ever written, never removed, so a bot that has been in many servers carries
 * one dead entry per server for the rest of its life.
 */
export function sweepJingleState(activeGuildIds?: Set<string>): number {
  const now = Date.now();
  let dropped = 0;

  for (const [guildId, nextAt] of nextAllowedJingle) {
    if (activeGuildIds && !activeGuildIds.has(guildId)) continue;
    if (now - nextAt < JINGLE_STATE_TTL_MS) continue;
    nextAllowedJingle.delete(guildId);
    dropped += 1;
  }
  for (const [guildId, lastAt] of lastStationIdAt) {
    if (activeGuildIds && !activeGuildIds.has(guildId)) continue;
    if (now - lastAt < JINGLE_STATE_TTL_MS) continue;
    lastStationIdAt.delete(guildId);
    dropped += 1;
  }
  for (const [name, lastAt] of jingleLastPlayed) {
    if (now - lastAt < JINGLE_STATE_TTL_MS) continue;
    jingleLastPlayed.delete(name);
  }

  return dropped;
}

/** Forget everything held for a guild that is going away. */
export function forgetJingleState(guildId: string): void {
  nextAllowedJingle.delete(guildId);
  lastStationIdAt.delete(guildId);
}
