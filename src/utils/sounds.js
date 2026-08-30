/**
 * Local soundboard file discovery.
 * Drop audio files into /sounds — no config or restart needed, this reads
 * the folder fresh on every call so newly-added files show up immediately.
 */

import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

export const SOUNDS_DIR = join(process.cwd(), 'sounds');
const ALLOWED_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac']);

function ensureDir() {
  if (!existsSync(SOUNDS_DIR)) mkdirSync(SOUNDS_DIR, { recursive: true });
}

/** @returns {string[]} sound names (file names without extension), sorted */
export function listSounds() {
  ensureDir();
  return readdirSync(SOUNDS_DIR)
    .filter((f) => ALLOWED_EXT.has(extname(f).toLowerCase()))
    .map((f) => basename(f, extname(f)))
    .sort((a, b) => a.localeCompare(b));
}

/** @returns {string|null} absolute path to the sound file, or null if not found */
export function resolveSoundPath(name) {
  ensureDir();
  const files = readdirSync(SOUNDS_DIR);
  const match = files.find(
    (f) => ALLOWED_EXT.has(extname(f).toLowerCase()) && basename(f, extname(f)) === name,
  );
  return match ? join(SOUNDS_DIR, match) : null;
}
