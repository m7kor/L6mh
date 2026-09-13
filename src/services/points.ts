/**
 * Points service — earn, spend, and query points.
 * Points are earned by listening to the radio and spent on skip/priority.
 */

import { getDb } from '../utils/database.js';
import { createLogger } from '../utils/logger.js';
import { getLevel } from '../lang.js';

const logger = createLogger('points');

const POINTS_PER_MINUTE = 1;
const DAILY_BONUS = 10;
const SKIP_COST = 5;
const PRIORITY_COST = 10;

export function addPoints(userId: string, guildId: string, delta: number, reason: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO member_stats (user_id, guild_id, points, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, guild_id) DO UPDATE SET
      points = points + ?,
      last_seen_at = datetime('now')
  `).run(userId, guildId, Math.max(0, delta), delta);

  db.prepare(`
    INSERT INTO points_log (user_id, guild_id, delta, reason)
    VALUES (?, ?, ?, ?)
  `).run(userId, guildId, delta, reason);

  const row = db.prepare('SELECT points FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId) as any;
  return row?.points ?? 0;
}

export function spendPoints(userId: string, guildId: string, cost: number, reason: string): { ok: boolean; balance: number } {
  const db = getDb();
  const row = db.prepare('SELECT points FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId) as any;
  const balance = row?.points ?? 0;

  if (balance < cost) return { ok: false, balance };

  addPoints(userId, guildId, -cost, reason);
  return { ok: true, balance: balance - cost };
}

export function getBalance(userId: string, guildId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT points FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId) as any;
  return row?.points ?? 0;
}

export function getLevelInfo(userId: string, guildId: string) {
  const balance = getBalance(userId, guildId);
  return { ...getLevel(balance), balance };
}

export function addListeningPoints(userId: string, guildId: string, minutesListened: number): void {
  if (minutesListened <= 0) return;
  const delta = minutesListened * POINTS_PER_MINUTE;
  addPoints(userId, guildId, delta, `listening_${minutesListened}m`);
}

export function awardDailyBonus(userId: string, guildId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT last_daily_at FROM member_stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId) as any;
  const today = new Date().toISOString().slice(0, 10);

  if (row?.last_daily_at === today) return false;

  db.prepare(`
    UPDATE member_stats SET last_daily_at = datetime('now') WHERE user_id = ? AND guild_id = ?
  `).run(userId, guildId);

  addPoints(userId, guildId, DAILY_BONUS, 'daily_bonus');
  return true;
}

export { SKIP_COST, PRIORITY_COST, DAILY_BONUS };
