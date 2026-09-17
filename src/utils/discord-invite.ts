/** Validate configured invite shape only; does not claim the invite is active. */
export function validateDiscordInviteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const validPath = url.hostname === 'discord.gg'
      ? /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      : url.hostname === 'discord.com' && /^\/invite\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    // Reject anything the URL parser normalizes (dot segments, extra params):
    // we serve back exactly the configured string, never a rewritten URL.
    if (!validPath || url.href !== raw) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
