/** 시간-of-day programming mode. 서버 로컬 시간 기준. */

export type ProgrammingMode = 'morning' | 'afternoon' | 'evening' | 'night';

export function getProgrammingMode(): ProgrammingMode {
  const hour = new Date().getHours();
  if (hour >= 6  && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

export const MODE_LABELS: Record<ProgrammingMode, string> = {
  morning:  'صباحك إنت ☀️',
  afternoon:'عصر هادي 🌤',
  evening:  'مساك عسل 🌙',
  night:    'ليلنا الفني 🌃',
};

export const MODE_SHORT: Record<ProgrammingMode, string> = {
  morning:  'صباحك',
  afternoon:'عصر',
  evening:  'مساء',
  night:    'ليل',
};
