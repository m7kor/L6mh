// @ts-nocheck
/**
 * Play-count persistence using SQLite.
 * Crash-safe, atomic writes via WAL mode.
 */
import { getDb } from './database.js';
import { createLogger } from './logger.js';
const logger = createLogger('stats');
/** Load all play counts as { videoId: { title, playCount, ... } }. */
export async function loadPlays() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM play_counts').all();
    const result = {};
    for (const row of rows) {
        result[row.video_id] = {
            title: row.title,
            playCount: row.play_count,
            firstPlayedAt: row.first_played_at,
            lastPlayedAt: row.last_played_at,
            lastCompleted: !!row.last_completed,
            failCount: row.fail_count,
        };
    }
    return result;
}
/**
 * Record a play event.
 * @param {object} video - { videoId, title, url }
 * @param {object} [opts]
 * @param {boolean} [opts.completed]
 * @param {boolean} [opts.failed]
 */
export async function recordPlay(video, opts = {}) {
    if (!video?.videoId)
        return;
    const db = getDb();
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM play_counts WHERE video_id = ?').get(video.videoId);
    if (!existing) {
        db.prepare(`
      INSERT INTO play_counts (video_id, title, play_count, first_played_at, last_played_at, last_completed, fail_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(video.videoId, video.title || null, (!opts.completed && !opts.failed) ? 1 : 0, now, now, opts.completed ? 1 : 0, opts.failed ? 1 : 0);
    }
    else {
        const playCount = existing.play_count + ((!opts.completed && !opts.failed) ? 1 : 0);
        const failCount = existing.fail_count + (opts.failed ? 1 : 0);
        const lastCompleted = opts.completed !== undefined ? (opts.completed ? 1 : 0) : existing.last_completed;
        const lastPlayedAt = (!opts.completed && !opts.failed) ? now : existing.last_played_at;
        db.prepare(`
      UPDATE play_counts SET title = ?, play_count = ?, last_played_at = ?, last_completed = ?, fail_count = ?
      WHERE video_id = ?
    `).run(video.title || existing.title, playCount, lastPlayedAt, lastCompleted, failCount, video.videoId);
    }
    // Append to history (only on track start)
    if (!opts.completed && !opts.failed) {
        db.prepare(`
      INSERT INTO play_history (video_id, title, guild_id, completed)
      VALUES (?, ?, ?, ?)
    `).run(video.videoId, video.title || null, video.guildId || null, 0);
        // Trim history to last 10000 entries
        db.prepare(`
      DELETE FROM play_history WHERE id NOT IN (
        SELECT id FROM play_history ORDER BY id DESC LIMIT 10000
      )
    `).run();
    }
}
/** Get recent play history (last N tracks). */
export async function getPlayHistory(limit = 20) {
    const db = getDb();
    return db.prepare('SELECT video_id as videoId, title, played_at as playedAt FROM play_history ORDER BY id DESC LIMIT ?').all(limit);
}
