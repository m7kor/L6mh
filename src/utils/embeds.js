/**
 * "Now Playing" embed + button row builders.
 * Kept separate from player.js so the playback engine doesn't need to
 * know anything about Discord UI concerns.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

const BAR_LENGTH = 18;

// Jewel-tone accents instead of flat UI colors — gold for the spotlight
// moment (latest upload), amethyst/emerald/indigo for the rest, so the
// card's left border reads like a gemstone rather than a status chip.
const MODE_COLOR = {
  random: 0x7c3aed, // amethyst — 24/7 radio
  latest: 0xd4af37, // gold — fresh upload, the spotlight moment
  url: 0x047857,    // emerald — manual pick
  resume: 0x3730a3, // deep indigo — picking back up
};
const PAUSED_COLOR = 0x44403c; // warm graphite, not flat gray

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

// A diamond playhead on a heavy/light rule — a small, deliberate flourish
// instead of a plain round dot.
function progressBar(elapsedSeconds, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) {
    return '🔴 `مباشر`  ✦  بث بدون مدة محددة';
  }
  const ratio = Math.max(0, Math.min(1, elapsedSeconds / durationSeconds));
  const filled = Math.round(ratio * BAR_LENGTH);
  const bar = '━'.repeat(filled) + '◆' + '─'.repeat(Math.max(0, BAR_LENGTH - filled));
  return `\`${formatTime(elapsedSeconds)}\`  ${bar}  \`${formatTime(durationSeconds)}\``;
}

/** Format a raw view count as a compact string, e.g. 1234567 → "1.2M". */
function formatViewCount(viewCount) {
  if (viewCount == null) return null;
  if (viewCount >= 1_000_000) return `${(viewCount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (viewCount >= 1_000) return `${(viewCount / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(viewCount);
}

/** Format an ISO date as YYYY-MM-DD, for the "uploaded" meta line. */
function formatUploadDate(iso) {
  if (!iso) return null;
  return iso.slice(0, 10);
}

/**
 * @param {{title:string, url:string, thumbnail?:string, durationSeconds?:number, viewCount?:number, publishedAt?:string}} video
 * @param {{volume:number, mode:string, continuous:boolean, paused?:boolean, elapsedSeconds?:number}} state
 */
export function buildNowPlayingEmbed(video, state) {
  const modeLabel = {
    random: '🎲 عشوائي مستمر',
    latest: '🆕 آخر فيديو',
    url: '🔗 رابط محدد',
    resume: '⏯️ استكمال',
  }[state.mode] || '▶️ تشغيل';

  const color = state.paused ? PAUSED_COLOR : (MODE_COLOR[state.mode] || 0x3730a3);

  // One clean content block instead of a grid of boxed fields — a single
  // scrubber line, then a compact meta row of star-separated stats. Reads
  // like a curated media card rather than a diagnostics panel.
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
    .setFooter({ text: state.paused ? '✦ متوقف مؤقتاً — اضغط ▶️ للمتابعة' : '✦ مباشر الآن' })
    .setTimestamp();

  if (video.thumbnail) embed.setImage(video.thumbnail);

  return embed;
}

export function buildControlRow({ paused = false, disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player:pauseresume')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('player:skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('player:volume_down')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('player:volume_up')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('player:stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}
