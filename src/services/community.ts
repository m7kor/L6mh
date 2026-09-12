/**
 * Community — tracks member presence and leaderboard.
 * Minimal: presence tracking + leaderboard for dashboard.
 */

import { createLogger } from '../utils/logger.js';
import { getDb } from '../utils/database.js';

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
    trackPresence(userId, guildId);
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

function trackPresence(userId, guildId) {
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
  } catch (err) {
    logger.warn('trackPresence error:', err.message);
  }
}

function addMinutes(userId, guildId, minutes) {
  try {
    if (isBlacklisted(userId)) return;
    const db = getDb();
    db.prepare(`
      UPDATE member_stats
      SET minutes_present = minutes_present + ?,
          last_seen_at = datetime('now')
      WHERE user_id = ? AND guild_id = ?
    `).run(minutes, userId, guildId);
  } catch (err) {
    logger.warn('addMinutes error:', err.message);
  }
}

/**
 * Get leaderboard for a guild (top N by minutes, excluding opted-out users).
 */
export function getLeaderboard(guildId, limit = 100) {
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
 * Check if a user is blacklisted.
 */
function isBlacklisted(userId) {
  try {
    const db = getDb();
    const row = db.prepare('SELECT user_id FROM blacklist WHERE user_id = ?').get(userId);
    return !!row;
  } catch {
    return false;
  }
}
