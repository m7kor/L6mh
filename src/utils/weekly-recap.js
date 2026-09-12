/**
 * Weekly recap — posts top 5 most-played videos to health webhook.
 *
 * Checks daily; if it's Monday (day 1), computes the weekly digest
 * from play-counts.json and posts via notify(). No new dependencies.
 */

import { createLogger } from './logger.js';
import { notify } from './webhook.js';
import { loadPlays } from './stats.js';

const logger = createLogger('recap');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let lastRecapDay = -1;

async function computeRecap() {
  const plays = await loadPlays();
  const now = Date.now();
  const cutoff = now - WEEK_MS;

  const recent = Object.entries(plays).filter(([, v]) => {
    if (!v.lastPlayedAt) return false;
    return new Date(v.lastPlayedAt).getTime() >= cutoff;
  });

  const sorted = recent.sort((a, b) => (b[1].playCount || 0) - (a[1].playCount || 0));
  return sorted.slice(0, 5);
}

export async function checkWeeklyRecap() {
  const today = new Date().getDay();
  if (today !== 1 || today === lastRecapDay) return;
  lastRecapDay = today;

  const top5 = await computeRecap();
  if (top5.length === 0) return;

  const lines = top5.map(([, v], i) =>
    `${i + 1}. **${v.title || '—'}** — ${v.playCount || 0} مرة`,
  );

  notify(
    '📊 ملخص الأسبوع',
    `أكثر 5 مقاطع تشغيلاً هذا الأسبوع:\n${lines.join('\n')}`,
    'info',
  ).catch(() => {});

  logger.info('Weekly recap posted.');
}
