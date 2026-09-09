/**
 * jingles.js — إدارة المؤثرات الصوتية والفواصل بين المقاطع.
 *
 * يعتمد على خوارزمية "أقل-ما-شُغِّل-مؤخراً" لاختيار الجينغل
 * لضمان التوزيع العادل بين المؤثرات المتاحة.
 */

import { createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
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
  const { joinVoiceChannel, entersState } = await import('@discordjs/voice');
  // ملاحظة: نستورد joinVoiceChannel من engine لتجنب دائرية الاستيراد
  // سيُمرَّر من engine.js عبر parameter
  // لذلك هذه الدالة تستقبل connection مباشرة بدلاً من إعادة إنشائه
  throw new Error('Use playSoundEffectWithConnection instead');
}

/**
 * تشغيل مؤثر صوتي على connection موجود أو إنشاء واحد جديد.
 * @param {import('@discordjs/voice').VoiceConnection|null} existingConnection
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').VoiceChannel} channel
 * @param {string} filePath
 * @param {Function} joinFn - دالة joinVoiceChannel من engine
 */
export function playSoundEffectWithConnection(existingConnection, guild, channel, filePath, joinFn) {
  const session = getSession(guild.id);

  return new Promise((resolve, reject) => {
    const alreadyHere = existingConnection
      && existingConnection.joinConfig.channelId === channel.id
      && existingConnection.state.status !== VoiceConnectionStatus.Destroyed;

    if (!alreadyHere) {
      if (existingConnection) {
        try { existingConnection.destroy(); } catch {}
      }
      const conn = joinFn(channel, guild);
      session.connection = conn;

      const { entersState } = require('@discordjs/voice');
      entersState(conn, VoiceConnectionStatus.Ready, 30_000)
        .then(() => playFile(conn))
        .catch((err) => reject(new Error(`تعذّر الاتصال بالقناة الصوتية: ${err.message}`)));
    } else {
      playFile(existingConnection);
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
      effectPlayer.on(AudioPlayerStatus.Idle, () => resolve());
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

    const interval = SOUNDS_MIN_MS + Math.random() * (SOUNDS_MAX_MS - SOUNDS_MIN_MS);
    nextAllowedJingle.set(guild.id, Date.now() + interval);
  } catch (err) {
    logger.warn(`[${guild.id}] Jingle failed:`, err.message);
  }
}
