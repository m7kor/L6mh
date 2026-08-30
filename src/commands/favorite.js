import { SlashCommandBuilder } from 'discord.js';
import { getSessionInfo } from '../services/player.js';
import { addFavorite } from '../utils/stats.js';

export const data = new SlashCommandBuilder()
  .setName('favorite')
  .setDescription('حفظ الفيديو الذي يشتغل الآن في مفضلتك');

export async function execute(interaction) {
  const info = getSessionInfo(interaction.guild.id);

  if (!info.current) {
    await interaction.reply({ content: '❌ ما في شيء قيد التشغيل الآن.', ephemeral: true });
    return;
  }

  const { added } = addFavorite(interaction.user.id, info.current);

  if (!added) {
    await interaction.reply({
      content: `⭐ **${info.current.title}** موجود بالفعل في مفضلتك — شوف /favorites.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `⭐ تمت الإضافة إلى مفضلتك: **${info.current.title}**`,
    ephemeral: true,
  });
}
