import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getTopPlayed } from '../utils/stats.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export const data = new SlashCommandBuilder()
  .setName('top')
  .setDescription('أكثر الفيديوهات تشغيلاً على هذا البوت');

export async function execute(interaction) {
  const top = getTopPlayed(10);

  if (top.length === 0) {
    await interaction.reply({ content: 'ما في إحصائيات تشغيل بعد — شغّل البوت شوي وارجع شوف /top.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle('🏆 الأكثر تشغيلاً على Waheedomar Radio')
    .setDescription(
      top
        .map((v, i) => `${MEDALS[i] || `${i + 1}.`} [${v.title}](${v.url}) — ${v.count} مرة`)
        .join('\n'),
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
