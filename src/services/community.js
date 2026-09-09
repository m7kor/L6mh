/**
 * Community / Gamification — tracks member presence and awards badges.
 * Read-only for display: leaderboard, badges, stats.
 * No playback control.
 *
 * النصوص والأوسمة مُستوردة من lang.js بدلاً من تعريفها هنا.
 */

import { createLogger } from '../utils/logger.js';
import { getDb } from '../utils/database.js';
import { BADGES, getLevel } from '../lang.js';

export { BADGES, getLevel };

const logger = createLogger('community');

// Presence tracking: in-memory map of userId+guildId → join timestamp
const presenceMap = new Map();

/**
 * Called when a user joins a voice channel.
 */
export function onVoiceJoin(userId, guildId) {
  const key = `${userId}:${guildId}`;
  if (!presenceMap.has(key)) {
    presenceMap.set(key, Date.now());
    trackPresence(userId, guildId, 'join');
  }
}

/**
 * Called when a user leaves a voice channel.
 */
export function onVoiceLeave(userId, guildId) {
  const key = `${userId}:${guildId}`;
  const joinTime = presenceMap.get(key);
  if (joinTime) {
    presenceMap.delete(key);
    const minutes = Math.round((Date.now() - joinTime) / 60000);
    if (minutes > 0) addMinutes(userId, guildId, minutes);
  }
}

function trackPresence(userId, guildId, event) {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO member_stats (user_id, guild_id, minutes_present, sessions_count, first_seen_at, last_seen_at)
      VALUES (?, ?, 0, 1, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        sessions_count = sessions_count + 1,
        last_seen_at = excluded.last_seen_at
    `).run(userId, guildId, now, now);
    // Award first_join badge
    awardBadge(userId, guildId, 'first_join');
    // Check night owl (hour 0-5 AM)
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 6) {
      awardBadge(userId, guildId, 'night_owl');
    }
  } catch (err) {
    logger.warn('trackPresence error:', err.message);
  }
}

function addMinutes(userId, guildId, minutes) {
  try {
    const db = getDb();
    // تحديث الدقائق وإضافة النقاط (1 نقطة كل 15 دقيقة)
    const pointsEarned = Math.floor(minutes / 15);
    db.prepare(`
      UPDATE member_stats
      SET minutes_present = minutes_present + ?,
          points = COALESCE(points, 0) + ?,
          last_seen_at = datetime('now')
      WHERE user_id = ? AND guild_id = ?
    `).run(minutes, pointsEarned, userId, guildId);

    if (pointsEarned > 0) {
      try {
        db.prepare(`INSERT INTO points_log (user_id, guild_id, reason, delta) VALUES (?, ?, 'listening', ?)`)
          .run(userId, guildId, pointsEarned);
      } catch {}
    }

    // فحص الأوسمة بناءً على ساعات الاستماع والجلسات
    const row = db.prepare('SELECT minutes_present, sessions_count FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
    if (row) {
      const hours = row.minutes_present / 60;
      if (hours >= 10)  awardBadge(userId, guildId, 'hours_10');
      if (hours >= 50)  awardBadge(userId, guildId, 'hours_50');
      if (hours >= 100) awardBadge(userId, guildId, 'hours_100');
      if (row.sessions_count >= 200) awardBadge(userId, guildId, 'addict');
    }
  } catch (err) {
    logger.warn('addMinutes error:', err.message);
  }
}

function awardBadge(userId, guildId, badgeId) {
  try {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO badges (user_id, guild_id, badge_id) VALUES (?, ?, ?)`)
      .run(userId, guildId, badgeId);
  } catch (err) {
    logger.warn('awardBadge error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// نظام النقاط — API عام
// ---------------------------------------------------------------------------

/**
 * يُرجع نقاط المستخدم الحالية في سيرفر معين.
 * @param {string} userId
 * @param {string} guildId
 * @returns {number}
 */
export function getUserPoints(userId, guildId) {
  try {
    const db  = getDb();
    const row = db.prepare('SELECT points FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
    return row?.points || 0;
  } catch {
    return 0;
  }
}

/**
 * يخصم نقاطاً من المستخدم ويُسجّل السبب.
 * يُرجع false إذا كانت النقاط غير كافية.
 * @param {string} userId
 * @param {string} guildId
 * @param {number} cost
 * @param {string} reason
 * @returns {boolean}
 */
export function deductPoints(userId, guildId, cost, reason = 'action') {
  try {
    const db      = getDb();
    const current = getUserPoints(userId, guildId);
    if (current < cost) return false;

    db.prepare('UPDATE member_stats SET points = points - ? WHERE user_id = ? AND guild_id = ?')
      .run(cost, userId, guildId);
    try {
      db.prepare('INSERT INTO points_log (user_id, guild_id, reason, delta) VALUES (?, ?, ?, ?)')
        .run(userId, guildId, reason, -cost);
    } catch {}
    return true;
  } catch (err) {
    logger.warn('deductPoints error:', err.message);
    return false;
  }
}

/**
 * يُضيف نقاطاً للمستخدم.
 * @param {string} userId
 * @param {string} guildId
 * @param {number} amount
 * @param {string} reason
 */
export function addPoints(userId, guildId, amount, reason = 'reward') {
  try {
    const db = getDb();
    db.prepare('UPDATE member_stats SET points = COALESCE(points, 0) + ? WHERE user_id = ? AND guild_id = ?')
      .run(amount, userId, guildId);
    try {
      db.prepare('INSERT INTO points_log (user_id, guild_id, reason, delta) VALUES (?, ?, ?, ?)')
        .run(userId, guildId, reason, amount);
    } catch {}
  } catch (err) {
    logger.warn('addPoints error:', err.message);
  }
}

/**
 * Get leaderboard for a guild (top N by minutes, excluding opted-out users).
 */
export function getLeaderboard(guildId, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT user_id, minutes_present, sessions_count, first_seen_at, last_seen_at
    FROM member_stats
    WHERE guild_id = ? AND opted_out = 0 AND minutes_present > 0
    ORDER BY minutes_present DESC
    LIMIT ?
  `).all(guildId, limit);
}

/**
 * Get badges for a user in a guild.
 */
export function getUserBadges(userId, guildId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT badge_id, earned_at FROM badges WHERE user_id = ? AND guild_id = ?
  `).all(userId, guildId);
  return rows.map(r => ({ ...BADGES[r.badge_id], earnedAt: r.earned_at })).filter(Boolean);
}

/**
 * Get a user's stats summary.
 */
export function getUserStats(userId, guildId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM member_stats WHERE user_id = ? AND guild_id = ?
  `).get(userId, guildId);
  return row || { user_id: userId, guild_id: guildId, minutes_present: 0, sessions_count: 0, opted_out: 0 };
}

/**
 * Check if user opted out of public leaderboard.
 */
export function isOptedOut(userId, guildId) {
  const db = getDb();
  const row = db.prepare('SELECT opted_out FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
  return row ? row.opted_out === 1 : false;
}

/**
 * Opt out a user from public leaderboard (preserves minutes_present).
 */
export function optOut(userId, guildId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO member_stats (user_id, guild_id, minutes_present, sessions_count, opted_out, first_seen_at, last_seen_at)
    VALUES (?, ?, 0, 0, 1, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, guild_id) DO UPDATE SET opted_out = 1
  `).run(userId, guildId);
}

/**
 * Opt back in (restore visibility on leaderboard).
 */
export function optIn(userId, guildId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO member_stats (user_id, guild_id, minutes_present, sessions_count, opted_out, first_seen_at, last_seen_at)
    VALUES (?, ?, 0, 0, 0, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, guild_id) DO UPDATE SET opted_out = 0
  `).run(userId, guildId);
}
