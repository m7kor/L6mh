// @ts-nocheck
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
 * @returns {{ name: string, category: string, at: number, guildId: string } | null}
 * Read and consume the oldest unread jingle event.
 */
export function consumeJingleEvent() {
  return jingleEventBuffer.shift() || null;
}

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

export function playSoundEffect(guild, channel, filePath) {
  const session = getSession(guild.id);

  return new Promise((resolve, reject) => {
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
        .then(() => playFile(session.connection))
        .catch((err) => reject(new Error(`تعذّر الاتصال بالقناة الصوتية: ${err.message}`)));
    } else {
      playFile(session.connection);
    }

    function playFile(conn) {
      const effectPlayer = createAudioPlayer();
      let resource;
      try {
        resource = createAudioResource(filePath);
      } catch (err) {
        reject(new Error(`تعذّر تشغيل الملف الصوتي: ${err.message}`));
        return;
      }
      effectPlayer.on('error', (err) => {
        logger.error(`[${guild.id}] Sound effect error:`, err.message);
        reject(err);
      });
      effectPlayer.on(AudioPlayerStatus.Idle, () => { resolve(); });
      conn.subscribe(effectPlayer);
      effectPlayer.play(resource);
    }
  });
}

// ---------------------------------------------------------------------------
// تشغيل جينغل عشوائي بين المقاطع
// ---------------------------------------------------------------------------

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

    await new Promise((resolve) => {
      const jinglePlayer = createAudioPlayer();
      let resource;
      try {
        resource = createAudioResource(filePath);
      } catch {
        resolve();
        return;
      }

      const cleanup = () => {
        try { session.connection?.subscribe(mainPlayer); } catch {}
        resolve();
      };

      jinglePlayer.on('error', cleanup);
      jinglePlayer.on(AudioPlayerStatus.Idle, cleanup);
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
