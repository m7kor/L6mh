/**
 * Per-user command cooldown.
 *
 * Disabled — no limits on command usage.
 */
const cooldowns = new Map();
const COOLDOWN_MS = 0;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const ENTRY_TTL_MS = COOLDOWN_MS * 3; // keep entries 3x the cooldown window
let lastSweep = Date.now();
function sweep() {
    const now = Date.now();
    if (now - lastSweep < SWEEP_INTERVAL_MS)
        return;
    lastSweep = now;
    for (const [key, ts] of cooldowns) {
        if (now - ts > ENTRY_TTL_MS)
            cooldowns.delete(key);
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
