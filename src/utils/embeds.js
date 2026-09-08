/**
 * "Now Playing" embed builder — Clean & Flat Layout (No Fields).
 */

import { EmbedBuilder } from 'discord.js';
import { formatTime } from './format.js';

const ROYAL_GOLD = 0xD4AF37; // Classic Gold
const PAUSED_COLOR = 0x2B2D31; // Invisible/Dark

const MODE_LABEL = {
  random: 'عشوائي مستمر',
  latest: 'أحدث الإصدارات',
  url: 'طلب حصري',
  resume: 'استكمال',
};

function formatViewCount(viewCount) {
  if (viewCount == null) return null;
  if (viewCount >= 1_000_000) return `${(viewCount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (viewCount >= 1_000) return `${(viewCount / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(viewCount);
}

function progressBar(elapsedSeconds, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) {
    return '🔴 **بث مباشر**';
  }
  const ratio = Math.max(0, Math.min(1, elapsedSeconds / durationSeconds));
  const BAR_LENGTH = 18;
  const filled = Math.round(ratio * BAR_LENGTH);
  
  // Clean flat slider (no markdown code blocks)
  let bar = '';
  if (filled === 0) {
    bar = '🔘' + '▬'.repeat(BAR_LENGTH - 1);
  } else if (filled >= BAR_LENGTH) {
    bar = '▬'.repeat(BAR_LENGTH - 1) + '🔘';
  } else {
    bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(BAR_LENGTH - filled - 1);
  }
  
  // Use LRM (Left-to-Right Mark) implicitly by placing English chars carefully 
  return `**${formatTime(elapsedSeconds)}** ${bar} **${formatTime(durationSeconds)}**`;
}

export function buildNowPlayingMessage(video, state) {
  const modeLabel = MODE_LABEL[state.mode] || 'تشغيل';
  const color = state.paused ? PAUSED_COLOR : ROYAL_GOLD;

  const progress = progressBar(state.elapsedSeconds ?? 0, video.durationSeconds);
  
  // Build a single, clean line for stats
  let stats = `🔊 **الصوت:** ${state.volume}%   •   🎛️ **الوضع:** ${modeLabel}`;
  const views = formatViewCount(video.viewCount);
  if (views) {
    stats += `   •   👁️ **المشاهدات:** ${views}`;
  }

  const description = `${progress}\n\n${stats}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: '🎙️ استوديو وحيد تك',
    })
    .setTitle(video.title)
    .setURL(video.url)
    .setDescription(description)
    .setFooter({
      text: state.paused ? '⏸️ متوقف مؤقتاً' : 'WaheedTech Radio 24/7',
    })
    .setTimestamp();

  if (video.thumbnail) {
    embed.setImage(video.thumbnail);
  }

  return { embeds: [embed], components: [] };
}

export function buildNowPlayingEmbed(video, state) {
  return buildNowPlayingMessage(video, state).embeds[0];
}
