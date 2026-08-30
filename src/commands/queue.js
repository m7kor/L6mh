import { SlashCommandBuilder } from 'discord.js';
import { getSessionInfo } from '../services/player.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('عرض المقطع الحالي والمقاطع القادمة');

export async function execute(interaction) {
  const info = getSessionInfo(interaction.guild.id);

  if (!info.current) {
    await interaction.reply({ content: 'لا يوجد شيء قيد التشغيل حالياً.', ephemeral: true });
    return;
  }

  let content = `🎵 **الآن يشغل:** ${info.current.title}`;
  content += `\n🔊 مستوى الصوت: ${info.volume}%`;

  if (info.mode === 'random') {
    content += info.queue.length > 0
      ? `\n\n**القادم:**\n${info.queue.map((v, i) => `${i + 1}. ${v.title}`).join('\n')}`
      : '\n\n(جاري تجهيز قائمة المقاطع القادمة…)';
  }

  await interaction.reply({ content, ephemeral: true });
}
