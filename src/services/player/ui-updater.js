/**
 * ui-updater.js — تحديث رسالة "الآن يعمل" في ديسكورد.
 *
 * التحسينات مقارنةً بالكود القديم:
 * - الفترة الزمنية ارتفعت من 15 ثانية → 30 ثانية لتخفيف Discord Rate Limit.
 * - التحديث الفوري مرتبط بأحداث (بداية مقطع، إيقاف، استكمال) بدلاً من الانتظار.
 */

import { createLogger } from '../../utils/logger.js';
import { buildNowPlayingMessage } from '../../utils/embeds.js';
import { getElapsedSeconds } from '../session.js';

const logger = createLogger('audio');

/**
 * تحديث شريط التقدم كل 30 ثانية (بدل 15).
 * تقليل استهلاك Discord API بنسبة 50%.
 */
const UI_REFRESH_MS = 30_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * ربط رسالة "الآن يعمل" بالجلسة وتشغيل التحديث الدوري.
 * @param {string} guildId
 * @param {import('discord.js').Message} message
 * @param {import('../session.js').GuildSession} session
 */
export function attachNowPlayingMessage(guildId, message, session) {
  session.nowPlayingMessage = message;
  startUiRefresh(session);
  updateNowPlayingMessage(session).catch(() => {});
}

/**
 * تحديث فوري للرسالة — يُستدعى عند أحداث التشغيل الرئيسية.
 * @param {import('../session.js').GuildSession} session
 */
export async function triggerUiUpdate(session) {
  await updateNowPlayingMessage(session);
}

/**
 * إيقاف التحديث الدوري وإزالة مرجع الرسالة.
 * @param {import('../session.js').GuildSession} session
 */
export function clearNowPlayingMessage(session) {
  stopUiRefresh(session);
  session.nowPlayingMessage = null;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function startUiRefresh(session) {
  stopUiRefresh(session);
  session.uiTimer = setInterval(() => {
    updateNowPlayingMessage(session).catch(() => {});
  }, UI_REFRESH_MS);
}

function stopUiRefresh(session) {
  if (session.uiTimer) {
    clearInterval(session.uiTimer);
    session.uiTimer = null;
  }
}

async function updateNowPlayingMessage(session) {
  if (!session.nowPlayingMessage || !session.current) return;
  try {
    const msg = buildNowPlayingMessage(session.current, {
      volume:         session.volume,
      mode:           session.mode,
      continuous:     session.continuous,
      paused:         session.paused,
      elapsedSeconds: getElapsedSeconds(session),
    });
    await session.nowPlayingMessage.edit(msg);
  } catch {
    // الرسالة حُذفت أو انتهت صلاحية التوكن — نوقف التحديث
    session.nowPlayingMessage = null;
    stopUiRefresh(session);
  }
}
