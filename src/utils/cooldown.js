/**
 * Per-user command cooldown.
 *
 * In-memory Map with periodic sweep to bound memory usage.
 * Resets on restart, which is fine for a cooldown.
 */

const cooldowns = new Map();
const COOLDOWN_MS = Number(process.env.COMMAND_COOLDOWN_MS) || 8_000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const ENTRY_TTL_MS = COOLDOWN_MS * 3; // keep entries 3x the cooldown window

let lastSweep = Date.now();

function sweep() {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, ts] of cooldowns) {
    if (now - ts > ENTRY_TTL_MS) cooldowns.delete(key);
  }
}

export function isOnCooldown(userId, commandName) {
  sweep();
  const key = `${userId}:${commandName}`;
  const last = cooldowns.get(key) || 0;
  return Date.now() - last < COOLDOWN_MS;
}

export function setCooldown(userId, commandName) {
  const key = `${userId}:${commandName}`;
  cooldowns.set(key, Date.now());
}

export function getRemainingCooldown(userId, commandName) {
  const key = `${userId}:${commandName}`;
  const last = cooldowns.get(key) || 0;
  const remaining = COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
