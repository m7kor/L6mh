/**
 * One-shot migration: play-counts.json → SQLite.
 * Runs automatically on startup if DB is empty but JSON files exist.
 */

import { readFile, access, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from './database.js';
import { createLogger } from './logger.js';

const logger = createLogger('migration');

const PLAYS_FILE = join(process.cwd(), 'play-counts.json');
const HISTORY_FILE = join(process.cwd(), 'play-history.json');

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function migrateJsonToSqlite() {
  const db = getDb();

  // Check if DB already has data
  const count = db.prepare('SELECT COUNT(*) as n FROM play_counts').get().n;
  if (count > 0) {
    logger.info(`Database already has ${count} records — skipping migration.`);
    return false;
  }

  // Check if old JSON file exists
  if (!(await fileExists(PLAYS_FILE))) {
    logger.info('No play-counts.json found — nothing to migrate.');
    return false;
  }

  logger.info('Migrating play-counts.json → SQLite...');

  try {
    const raw = JSON.parse(await readFile(PLAYS_FILE, 'utf-8'));
    const insert = db.prepare(`
      INSERT OR REPLACE INTO play_counts (video_id, title, play_count, first_played_at, last_played_at, last_completed, fail_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((entries) => {
      for (const [videoId, data] of entries) {
        insert.run(
          videoId,
          data.title || null,
          data.playCount || data.count || 0,
          data.firstPlayedAt || null,
          data.lastPlayedAt || null,
          data.lastCompleted ? 1 : 0,
          data.failCount || 0,
        );
      }
    });

    insertMany(Object.entries(raw));
    logger.info(`Migrated ${Object.keys(raw).length} videos from play-counts.json.`);
  } catch (err) {
    logger.error('Migration failed:', err.message);
    return false;
  }

  // Migrate history
  if (await fileExists(HISTORY_FILE)) {
    try {
      const history = JSON.parse(await readFile(HISTORY_FILE, 'utf-8'));
      const insertHist = db.prepare(`
        INSERT INTO play_history (video_id, title, played_at, completed)
        VALUES (?, ?, ?, ?)
      `);

      const insertHistory = db.transaction((items) => {
        for (const item of items) {
          insertHist.run(
            item.videoId || item.id,
            item.title || null,
            item.playedAt || null,
            item.completed ? 1 : 0,
          );
        }
      });

      insertHistory(history);
      logger.info(`Migrated ${history.length} history entries.`);
    } catch (err) {
      logger.warn('History migration failed (non-fatal):', err.message);
    }
  }

  // Rename old files to .bak
  try {
    await rename(PLAYS_FILE, PLAYS_FILE + '.bak');
    logger.info('Renamed play-counts.json → play-counts.json.bak');
  } catch {}
  try {
    await rename(HISTORY_FILE, HISTORY_FILE + '.bak');
    logger.info('Renamed play-history.json → play-history.json.bak');
  } catch {}

  return true;
}
