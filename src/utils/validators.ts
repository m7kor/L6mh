/**
 * Shared validation utilities.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidVideoId(id: string): boolean {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

export function clampVolume(vol: number, min = 0, max = 200): number {
  if (Number.isNaN(vol)) return 100;
  return Math.max(min, Math.min(max, Math.round(vol)));
}

export function isValidVolumeRange(vol: number): boolean {
  return Number.isInteger(vol) && vol >= 0 && vol <= 200;
}

export function parseVolumeInput(input: string | number): number | null {
  const num = typeof input === 'string' ? parseInt(input, 10) : input;
  if (Number.isNaN(num)) return null;
  return clampVolume(num);
}

/**
 * Make untrusted input safe to place inside a quoted message body.
 *
 * Angle brackets and control characters are removed and the result is capped.
 * The dashboard renders command replies into the DOM, so echoing a command
 * back verbatim is a reflected-input primitive that only needs one careless
 * future renderer to become stored XSS. Stripping the characters that let a
 * string break out of a text context is cheaper than auditing every renderer.
 */
export function forDisplay(value: unknown, maxLength = 40): string {
  const stripped = String(value ?? '')
    .replace(/[<>]/g, '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, maxLength)}…`;
}
