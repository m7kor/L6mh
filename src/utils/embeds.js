/**
 * "Now Playing" embed builder.
 */

import { EmbedBuilder } from 'discord.js';

const BAR_LENGTH = 20;

const MODE_LABEL = {
  random: '🎲 عشوائي مستمر',
  latest: '🆕 آخر فيديو',
  url: '🔗 رابط محدد',
  resume: '⏯️ استكمال',
};

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

function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return null;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function progressBar(elapsedSeconds, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) {
    return '> 🔴 **مباشر** — بث حي بدون مدة محددة';
  }
  const ratio = Math.max(0, Math.min(1, elapsedSeconds / durationSeconds));
  const filled = Math.round(ratio * BAR_LENGTH);
  const empty = BAR_LENGTH - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const pct = Math.round(ratio * 100);
  return `> ${bar}  ${pct}%\n> \`${formatTime(elapsedSeconds)}\` ─── \`${formatTime(durationSeconds)}\``;
}

function formatViewCount(viewCount) {
  if (viewCount == null) return null;
  if (viewCount >= 1_000_000) return `${(viewCount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (viewCount >= 1_000) return `${(viewCount / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(viewCount);
}

function formatUploadDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'اليوم';
  if (diffDays === 1) return 'أمس';
  if (diffDays < 7) return `منذ ${diffDays} أيام`;
  if (diffDays < 30) return `منذ ${Math.floor(diffDays / 7)} أسابيع`;
  return iso.slice(0, 10);
}

export function buildNowPlayingEmbed(video, state) {
  const modeLabel = MODE_LABEL[state.mode] || '▶️ تشغيل';
  const color = state.paused ? PAUSED_COLOR : (MODE_COLOR[state.mode] || 0x3730a3);

  // Progress bar
  const progress = progressBar(state.elapsedSeconds ?? 0, video.durationSeconds);

  // Metadata fields
  const fields = [];

  fields.push({
    name: 'الوضع',
    value: modeLabel,
    inline: true,
  });

  fields.push({
    name: 'الصوت',
    value: `🔊 ${state.volume}%`,
    inline: true,
  });

  if (video.durationSeconds) {
    fields.push({
      name: 'المدة',
      value: formatDuration(video.durationSeconds) || '—',
      inline: true,
    });
  }

  const viewsLabel = formatViewCount(video.viewCount);
  if (viewsLabel) {
    fields.push({
      name: 'المشاهدات',
      value: `👁️ ${viewsLabel}`,
      inline: true,
    });
  }

  const uploadLabel = formatUploadDate(video.publishedAt);
  if (uploadLabel) {
    fields.push({
      name: 'النشر',
      value: `📅 ${uploadLabel}`,
      inline: true,
    });
  }

  if (state.queueCount > 0) {
    fields.push({
      name: 'القائمة',
      value: `📋 ${state.queueCount} مقاطع`,
      inline: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: '👑 Waheedomar Radio',
      iconURL: 'https://i.imgur.com/3JY4YMN.png',
    })
    .setTitle(video.title)
    .setURL(video.url)
    .setDescription(progress)
    .addFields(fields)
    .setFooter({
      text: state.paused
        ? '⏸️ متوقف مؤقتاً — اكتب /كمل للاستئناف'
        : '🎧 مباشر الآن',
    })
    .setTimestamp();

  if (video.thumbnail) {
    embed.setThumbnail(video.thumbnail);
  }

  return embed;
}
