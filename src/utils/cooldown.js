/**
 * Per-user command cooldown.
 *
 * In-memory Map — resets on restart, which is fine for a cooldown.
 * Returns true if the user is still on cooldown.
 */

const cooldowns = new Map();
const COOLDOWN_MS = Number(process.env.COMMAND_COOLDOWN_MS) || 8_000;

export function isOnCooldown(userId, commandName) {
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
