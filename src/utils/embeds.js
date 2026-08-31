/**
 * "Now Playing" embed builder (no buttons).
 */

import { EmbedBuilder } from 'discord.js';

const BAR_LENGTH = 18;

const MODE_COLOR = {
  random: 0x7c3aed,
  latest: 0xd4af37,
  url: 0x047857,
  resume: 0x3730a3,
};
const PAUSED_COLOR = 0x44403c;

export function formatTime(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '0:00';
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function progressBar(elapsedSeconds, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) {
    return '🔴 `مباشر`  ✦  بث بدون مدة محددة';
  }
  const ratio = Math.max(0, Math.min(1, elapsedSeconds / durationSeconds));
  const filled = Math.round(ratio * BAR_LENGTH);
  const bar = '━'.repeat(filled) + '◆' + '─'.repeat(Math.max(0, BAR_LENGTH - filled));
  return `\`${formatTime(elapsedSeconds)}\`  ${bar}  \`${formatTime(durationSeconds)}\``;
}

function formatViewCount(viewCount) {
  if (viewCount == null) return null;
  if (viewCount >= 1_000_000) return `${(viewCount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (viewCount >= 1_000) return `${(viewCount / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(viewCount);
}

function formatUploadDate(iso) {
  if (!iso) return null;
  return iso.slice(0, 10);
}

export function buildNowPlayingEmbed(video, state) {
  const modeLabel = {
    random: '🎲 عشوائي مستمر',
    latest: '🆕 آخر فيديو',
    url: '🔗 رابط محدد',
    resume: '⏯️ استكمال',
  }[state.mode] || '▶️ تشغيل';

  const color = state.paused ? PAUSED_COLOR : (MODE_COLOR[state.mode] || 0x3730a3);

  const metaParts = [modeLabel, `🔊 ${state.volume}%`];
  const viewsLabel = formatViewCount(video.viewCount);
  const uploadLabel = formatUploadDate(video.publishedAt);
  if (viewsLabel) metaParts.push(`👁️ ${viewsLabel}`);
  if (uploadLabel) metaParts.push(`📅 ${uploadLabel}`);

  const description = [
    progressBar(state.elapsedSeconds ?? 0, video.durationSeconds),
    '',
    metaParts.join('   ✦   '),
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: '👑 Waheedomar Radio' })
    .setTitle(`✨ ${video.title}`)
    .setURL(video.url)
    .setDescription(description)
    .setFooter({ text: state.paused ? '✦ متوقف مؤقتاً' : '✦ مباشر الآن' })
    .setTimestamp();

  if (video.thumbnail) embed.setImage(video.thumbnail);

  return embed;
}
