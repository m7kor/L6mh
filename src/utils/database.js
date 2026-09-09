/**
 * SQLite database for play counts and session state.
 * Replaces JSON files for crash-safe persistence.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('db');

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'bot.db');

let db;

export function getDb() {
  if (!db) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
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
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}
