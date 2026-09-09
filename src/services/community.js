/**
 * Community / Gamification — tracks member presence and awards badges.
 * Read-only for display: leaderboard, badges, stats.
 * No playback control.
 */

import { createLogger } from '../utils/logger.js';
import { getDb } from '../utils/database.js';

const logger = createLogger('community');

// Presence tracking: in-memory map of userId+guildId → join timestamp
const presenceMap = new Map();

const BADGES = {
  first_join: { id: 'first_join', name: 'مستمع دائم', emoji: '🎧', desc: 'أول انضمام للروم الصوتي' },
  hours_10:   { id: 'hours_10',   name: 'لا يفوّت شي', emoji: '🔥', desc: '١٠ ساعات استماع تراكمية' },
  hours_50:   { id: 'hours_50',   name: 'نجم الروم',   emoji: '⭐', desc: '٥٠ ساعة استماع تراكمية' },
  night_owl:  { id: 'night_owl',  name: 'سهران',        emoji: '🌙', desc: 'حضور متكرر بعد الساعة ١٢ ليلاً' },
};

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
    db.prepare(`
      UPDATE member_stats SET minutes_present = minutes_present + ?, last_seen_at = datetime('now')
      WHERE user_id = ? AND guild_id = ?
    `).run(minutes, userId, guildId);
    // Check hour badges
    const row = db.prepare('SELECT minutes_present FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
    if (row) {
      const hours = row.minutes_present / 60;
      if (hours >= 10) awardBadge(userId, guildId, 'hours_10');
      if (hours >= 50) awardBadge(userId, guildId, 'hours_50');
    }
  } catch (err) {
    logger.warn('addMinutes error:', err.message);
  }
}

function awardBadge(userId, guildId, badgeId) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO badges (user_id, guild_id, badge_id) VALUES (?, ?, ?)
    `).run(userId, guildId, badgeId);
  } catch (err) {
    logger.warn('awardBadge error:', err.message);
  }
}

/**
 * Get leaderboard for a guild (top N by minutes).
 */
export function getLeaderboard(guildId, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT user_id, minutes_present, sessions_count, first_seen_at, last_seen_at
    FROM member_stats
    WHERE guild_id = ?
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
  return row || { user_id: userId, guild_id: guildId, minutes_present: 0, sessions_count: 0 };
}

/**
 * Check if user opted out of public leaderboard.
 */
export function isOptedOut(userId, guildId) {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM member_stats WHERE user_id = ? AND guild_id = ? AND minutes_present < 0').get(userId, guildId);
  return !!row;
}

/**
 * Opt out a user from public leaderboard (set minutes to negative sentinel).
 */
export function optOut(userId, guildId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO member_stats (user_id, guild_id, minutes_present, sessions_count, first_seen_at, last_seen_at)
    VALUES (?, ?, -1, 0, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, guild_id) DO UPDATE SET minutes_present = -1
  `).run(userId, guildId);
}

export { BADGES };
