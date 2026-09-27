/**
 * ui-updater.js — تحديث رسالة "الآن يعمل" في ديسكورد.
 *
 * التحسينات مقارنةً بالكود القديم:
 * - الفترة الزمنية ارتفعت من 15 ثانية → 30 ثانية لتخفيف Discord Rate Limit.
 * - التحديث الفوري مرتبط بأحداث (بداية مقطع، إيقاف، استكمال) بدلاً من الانتظار.
 */

import { buildNowPlayingMessage } from '../../utils/embeds.js';
import { getElapsedSeconds, getSession } from '../session.js';


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
 * @param guildId مطلوب فقط عندما لا تُمرَّر الجلسة
 */
export function attachNowPlayingMessage(guildId, message, session = getSession(guildId)) {
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

/**
 * إيقاف التحديث الدوري فقط، مع الإبقاء على مرجع الرسالة.
 *
 * A non-manual stop (track end, failed rejoin, scheduler) leaves the message
 * on screen, so the reference has to survive — but the refresh must not. Left
 * running, it edits a message about a track that is no longer playing, once
 * every 30 seconds, forever.
 */
export function stopNowPlayingRefresh(session) {
  stopUiRefresh(session);
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
  const msg = buildNowPlayingMessage(session.current, {
    volume:         session.volume,
    mode:           session.mode,
    continuous:     session.continuous,
    paused:         session.paused,
    elapsedSeconds: getElapsedSeconds(session),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await session.nowPlayingMessage.edit(msg);
      return;
    } catch (err) {
      if (err?.code === 50013 || err?.httpStatus === 404) {
        session.nowPlayingMessage = null;
        stopUiRefresh(session);
        return;
      }
      if (err?.code === 429 || err?.httpStatus === 429) {
        const retryAfter = err?.retryAfter || (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }
      if (attempt === 2) {
        session.nowPlayingMessage = null;
        stopUiRefresh(session);
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
