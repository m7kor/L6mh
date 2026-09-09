/**
 * "Now Playing" embed builder — Waheed Omar Radio identity.
 * Cyan/Orange theme with Iraqi personality.
 */

import { EmbedBuilder } from 'discord.js';
import { formatTime } from './format.js';

const RADIO_CYAN = 0x00E5FF;
const RADIO_ORANGE = 0xFF6B35;
const PAUSED_COLOR = 0x2B2D31;

const MODE_LABEL = {
  random: '🎲 عشوائي مستمر',
  latest: '🆕 آخر إصدار',
  url: '🎯 طلب خاص',
  resume: '🔄 استكمال',
};

const PERSONALITY = [
  'الآن معكم على الهوا 🎙️',
  'البث مباشر ahora 📡',
  'نشتغل بشدة 💪',
  'waheed Radio live 🔴',
  'الحياة والكمبيوتر continues 🖥️',
];

function progressBar(elapsed, duration) {
  if (!duration || duration <= 0) return '🔴 **بث مباشر**';
  const ratio = Math.max(0, Math.min(1, elapsed / duration));
  const BAR = 20;
  const filled = Math.round(ratio * BAR);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR - filled);
  return `\`${formatTime(elapsed)}\` ${bar} \`${formatTime(duration)}\``;
}

export function buildNowPlayingMessage(video, state) {
  const modeLabel = MODE_LABEL[state.mode] || '▶️ تشغيل';
  const color = state.paused ? PAUSED_COLOR : RADIO_CYAN;
  const personality = PERSONALITY[Math.floor(Math.random() * PERSONALITY.length)];

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
