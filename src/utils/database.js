/**
 * SQLite database for play counts and session state.
 * Replaces JSON files for crash-safe persistence.
 * In test mode (NODE_ENV=test), uses in-memory DB to avoid polluting production data.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('db');

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = process.env.NODE_ENV === 'test' ? ':memory:' : join(DATA_DIR, 'bot.db');

let db;

export function getDb() {
  if (!db) {
    try {
      if (DB_PATH !== ':memory:') mkdirSync(DATA_DIR, { recursive: true });
      db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      initTables();
      logger.info('Database connected');
    } catch (err) {
      logger.error('Database connection failed:', err.message);
      throw err;
    }
  }
  return db;
}

/**
 * Close the database connection (for clean shutdown).
 */
export function closeDb() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS play_counts (
      video_id TEXT PRIMARY KEY,
      title TEXT,
      play_count INTEGER DEFAULT 0,
      first_played_at TEXT,
      last_played_at TEXT,
      last_completed INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      title TEXT,
      guild_id TEXT,
      played_at TEXT DEFAULT (datetime('now')),
      completed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_state (
      guild_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS member_stats (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      minutes_present INTEGER DEFAULT 0,
      sessions_count INTEGER DEFAULT 0,
      opted_out INTEGER DEFAULT 0,
      points INTEGER DEFAULT 0,
      first_seen_at TEXT,
      last_seen_at TEXT,
      PRIMARY KEY (user_id, guild_id)
    );

    CREATE TABLE IF NOT EXISTS badges (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      badge_id TEXT NOT NULL,
      earned_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, guild_id, badge_id)
    );

    CREATE TABLE IF NOT EXISTS points_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      reason TEXT,
      delta INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_details (
      video_id TEXT PRIMARY KEY,
      title TEXT,
      duration_s INTEGER,
      thumbnail TEXT,
      view_count INTEGER,
      published_at TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add opted_out column if missing (for existing DBs)
  try {
    const cols = db.prepare("PRAGMA table_info(member_stats)").all();
    if (!cols.some(c => c.name === 'opted_out')) {
      db.exec("ALTER TABLE member_stats ADD COLUMN opted_out INTEGER DEFAULT 0");
      logger.info('Added opted_out column to member_stats');
    }
    // Migration: add points column if missing
    if (!cols.some(c => c.name === 'points')) {
      db.exec("ALTER TABLE member_stats ADD COLUMN points INTEGER DEFAULT 0");
      logger.info('Added points column to member_stats');
    }
  } catch {}

  // Migration: fix any rows with minutes_present = -1 (old broken opt-out)
  try {
    const fixed = db.prepare("UPDATE member_stats SET minutes_present = 0, opted_out = 1 WHERE minutes_present = -1").run();
    if (fixed.changes > 0) logger.info(`Fixed ${fixed.changes} rows with negative minutes_present`);
  } catch {}
}
