import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getSessionInfo } from '../services/player/controls.js';
import { MODE_LABELS, randomPersonalityLine } from '../lang.js';

export const data = new SlashCommandBuilder()
  .setName('الان_يتشغيل')
  .setDescription('عرض المقطع الذي يعمل حالياً');

export async function execute(interaction) {
  const info = getSessionInfo(interaction.guildId);
  const title = info?.current?.title;
  if (!title) {
    await interaction.reply({ content: '🔇 لا يوجد مقطع يعمل حالياً.', ephemeral: true });
    return;
  }

  const elapsed = formatDuration(info.elapsedSeconds || 0);
  const duration = info.durationSeconds ? formatDuration(info.durationSeconds) : 'لايف';
  const progress = info.durationSeconds
    ? '█'.repeat(Math.floor((info.elapsedSeconds / info.durationSeconds) * 15)) + '░'.repeat(15 - Math.floor((info.elapsedSeconds / info.durationSeconds) * 15))
    : '█'.repeat(15);

  const embed = new EmbedBuilder()
    .setColor(info.paused ? 0xFF6B35 : 0x00E5FF)
    .setTitle('🎵 الآن يُشغَّل')
    .setDescription(`**${title}**`)
    .addFields(
      { name: '📊 الحالة', value: info.paused ? '⏸️ متوقف مؤقتاً' : '▶️ يعمل الآن', inline: true },
      { name: '⏱️ المدة', value: `${elapsed} / ${duration}`, inline: true },
      { name: '🎲 الوضع', value: MODE_LABELS[info.mode] || info.mode || '—', inline: true },
    )
    .setFooter({ text: randomPersonalityLine() });

  if (info.videoId) {
    embed.setThumbnail(`https://i.ytimg.com/vi/${info.videoId}/mqdefault.jpg`);
    embed.setURL(`https://www.youtube.com/watch?v=${info.videoId}`);
  } else if (info.thumbnail) {
    embed.setThumbnail(info.thumbnail);
  }

  if (info.durationSeconds) {
    embed.addFields({ name: '进度', value: `\`${progress}\` ${elapsed} / ${duration}`, inline: false });
  }

  await interaction.reply({ embeds: [embed] });
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
