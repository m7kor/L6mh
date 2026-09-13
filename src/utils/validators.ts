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
