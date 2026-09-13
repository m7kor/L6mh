/**
 * Community — tracks member presence, badges, and leaderboard.
 */

import { createLogger } from '../utils/logger.js';
import { getDb } from '../utils/database.js';
import { BADGES } from '../lang.js';

const logger = createLogger('community');

const presenceMap = new Map();

export function onVoiceJoin(userId: string, guildId: string, username?: string, avatarUrl?: string): void {
  const key = `${userId}:${guildId}`;
  if (!presenceMap.has(key)) {
    presenceMap.set(key, Date.now());
    trackPresence(userId, guildId, username, avatarUrl);
    checkBadges(userId, guildId);
  } else if (username || avatarUrl) {
    try {
      const db = getDb();
      const sets: string[] = [];
      const vals: any[] = [];
      if (username) { sets.push('username = ?'); vals.push(username); }
      if (avatarUrl) { sets.push('avatar_url = ?'); vals.push(avatarUrl); }
      if (sets.length > 0) {
        vals.push(userId, guildId);
        db.prepare(`UPDATE member_stats SET ${sets.join(', ')} WHERE user_id = ? AND guild_id = ?`).run(...vals);
      }
    } catch (err) { logger.debug(`onVoiceJoin update failed: ${err.message}`); }
  }
}

export function onVoiceLeave(userId: string, guildId: string): void {
  const key = `${userId}:${guildId}`;
  const joinTime = presenceMap.get(key);
  if (joinTime) {
    presenceMap.delete(key);
    const minutes = Math.round((Date.now() - joinTime) / 60000);
    if (minutes > 0) addMinutes(userId, guildId, minutes);
    checkBadges(userId, guildId);
  }
}

function trackPresence(userId: string, guildId: string, username?: string, avatarUrl?: string): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO member_stats (user_id, guild_id, minutes_present, sessions_count, first_seen_at, last_seen_at, username, avatar_url)
      VALUES (?, ?, 0, 1, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        sessions_count = sessions_count + 1,
        last_seen_at = excluded.last_seen_at,
        username = COALESCE(excluded.username, username),
        avatar_url = COALESCE(excluded.avatar_url, avatar_url)
    `).run(userId, guildId, now, now, username || null, avatarUrl || null);
  } catch (err) {
    logger.warn('trackPresence error:', err.message);
  }
}

function addMinutes(userId: string, guildId: string, minutes: number): void {
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

export function checkBadges(userId: string, guildId: string): void {
  try {
    const db = getDb();
    const stats = db.prepare(
      'SELECT minutes_present, sessions_count, last_seen_at FROM member_stats WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as any;
    if (!stats) return;

    const existing = db.prepare(
      'SELECT badge_id FROM badges WHERE user_id = ? AND guild_id = ?'
    ).all(userId, guildId) as any[];
    const earned = new Set(existing.map((r: any) => r.badge_id));

    const toAward: string[] = [];

    if (!earned.has('first_join')) toAward.push('first_join');

    const hours = stats.minutes_present / 60;
    if (hours >= 10 && !earned.has('hours_10')) toAward.push('hours_10');
    if (hours >= 50 && !earned.has('hours_50')) toAward.push('hours_50');
    if (hours >= 100 && !earned.has('hours_100')) toAward.push('hours_100');

    if (stats.sessions_count >= 200 && !earned.has('addict')) toAward.push('addict');

    const hour = new Date().getHours();
    if (hour >= 0 && hour < 4 && !earned.has('night_owl')) toAward.push('night_owl');
    if (hour >= 4 && hour < 7 && !earned.has('dawn_guard')) toAward.push('dawn_guard');

    if (checkStreak(userId, guildId, 7) && !earned.has('loyal')) toAward.push('loyal');

    for (const badgeId of toAward) {
      db.prepare(`
        INSERT OR IGNORE INTO badges (user_id, guild_id, badge_id) VALUES (?, ?, ?)
      `).run(userId, guildId, badgeId);
      const badge = BADGES[badgeId as keyof typeof BADGES];
      if (badge) logger.info(`Badge awarded: ${badge.emoji} ${badge.name} → ${userId} in ${guildId}`);
    }
  } catch (err) {
    logger.warn('checkBadges error:', err.message);
  }
}

function checkStreak(userId: string, guildId: string, days: number): boolean {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(DISTINCT date(played_at)) as streak_days
      FROM play_history
      WHERE guild_id = ?
        AND played_at >= datetime('now', '-' || ? || ' days')
    `).get(guildId, days) as any;
    return row?.streak_days >= days;
  } catch {
    return false;
  }
}

export function getUserBadges(userId: string, guildId: string) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT badge_id, earned_at FROM badges WHERE user_id = ? AND guild_id = ? ORDER BY earned_at'
  ).all(userId, guildId) as any[];
  return rows.map(r => ({ ...BADGES[r.badge_id as keyof typeof BADGES], earned_at: r.earned_at })).filter(Boolean);
}

export function getLeaderboard(guildId: string, limit = 100) {
  const db = getDb();
  return db.prepare(`
    SELECT user_id, minutes_present, sessions_count, points, username, avatar_url, first_seen_at, last_seen_at
    FROM member_stats
    WHERE guild_id = ? AND opted_out = 0 AND minutes_present > 0
    ORDER BY minutes_present DESC
    LIMIT ?
  `).all(guildId, limit);
}

function isBlacklisted(userId: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare('SELECT user_id FROM blacklist WHERE user_id = ?').get(userId);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Backfill usernames using client.users.fetch() (no GuildMembers intent needed).
 * Called on bot startup to ensure all existing members have usernames stored.
 */
export async function backfillUsernames(client: any): Promise<number> {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT user_id FROM member_stats WHERE username IS NULL OR username = '' OR avatar_url IS NULL"
    ).all() as any[];
    if (rows.length === 0) return 0;

    let updated = 0;
    for (const row of rows) {
      try {
        const user = await client.users.fetch(row.user_id);
        if (user && user.username) {
          const avatarUrl = user.displayAvatarURL({ size: 64, extension: 'png' }) || null;
          db.prepare('UPDATE member_stats SET username = ?, avatar_url = ? WHERE user_id = ?')
            .run(user.username, avatarUrl, row.user_id);
          updated++;
        }
      } catch {
        // User not found or DM-only — skip
      }
    }
    if (updated > 0) logger.info(`Backfilled ${updated} usernames+avatars`);
    return updated;
  } catch (err) {
    logger.warn('backfillUsernames error:', err.message);
    return 0;
  }
}
