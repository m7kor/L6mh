/**
 * "Now Playing" embed builder — Waheed Omar Radio identity.
 * Cyan/Orange theme with Iraqi personality.
 *
 * النصوص مُستوردة من lang.js بدلاً من تعريفها هنا.
 */

import { EmbedBuilder } from 'discord.js';
import { formatTime } from './format.js';
import { MODE_LABELS, randomPersonalityLine } from '../lang.js';

const RADIO_CYAN   = 0x00E5FF;
const RADIO_ORANGE = 0xFF6B35;
const PAUSED_COLOR = 0x2B2D31;

function progressBar(elapsed, duration) {
  if (!duration || duration <= 0) return '🔴 **بث مباشر**';
  const ratio = Math.max(0, Math.min(1, elapsed / duration));
  const BAR = 20;
  const filled = Math.round(ratio * BAR);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR - filled);
  return `\`${formatTime(elapsed)}\` ${bar} \`${formatTime(duration)}\``;
}

export function buildNowPlayingMessage(video, state) {
  const modeLabel = MODE_LABELS[state.mode] || '▶️ تشغيل';
  const color = state.paused ? PAUSED_COLOR : RADIO_CYAN;
  const personality = randomPersonalityLine();

  const progress = progressBar(state.elapsedSeconds ?? 0, video.durationSeconds);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: '🎙️ راديو وحيد عمر',
      iconURL: 'https://i.ytimg.com/vi/' + (video.videoId || '') + '/mqdefault.jpg',
    })
    .setTitle(video.title || '—')
    .setURL(video.url)
    .setDescription(`${progress}\n\n${modeLabel}`)
    .setFooter({
      text: state.paused ? '⏸️ متوقف مؤقتاً' : `${personality}`,
    })
    .setTimestamp();

  if (video.thumbnail) {
    embed.setThumbnail(video.thumbnail);
  }

  return { embeds: [embed], components: [] };
}

export function buildNowPlayingEmbed(video, state) {
  return buildNowPlayingMessage(video, state).embeds[0];
}
