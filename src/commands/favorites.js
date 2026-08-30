import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getFavorites, removeFavorite } from '../utils/stats.js';

const MAX_SHOWN = 15;

export const data = new SlashCommandBuilder()
  .setName('favorites')
  .setDescription('عرض قائمة مفضلتك')
  .addStringOption((opt) => opt
    .setName('remove')
    .setDescription('احذف فيديو من مفضلتك (اكتب جزء من العنوان)'));

export async function execute(interaction) {
  const removeQuery = interaction.options.getString('remove');

  if (removeQuery) {
    const list = getFavorites(interaction.user.id);
    const match = list.find((v) => v.title.toLowerCase().includes(removeQuery.toLowerCase()));
    if (!match) {
      await interaction.reply({ content: `❌ ما لقيت فيديو في مفضلتك يطابق "${removeQuery}".`, ephemeral: true });
      return;
    }
    removeFavorite(interaction.user.id, match.videoId);
    await interaction.reply({ content: `🗑️ تم حذف **${match.title}** من مفضلتك.`, ephemeral: true });
    return;
  }

  const list = getFavorites(interaction.user.id);

  if (list.length === 0) {
    await interaction.reply({
      content: 'ما عندك أي مفضلة بعد — استخدم /favorite وأنت تسمع فيديو عشان تضيفه.',
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(`⭐ مفضلة ${interaction.user.username}`)
    .setDescription(
      list
        .slice(0, MAX_SHOWN)
        .map((v, i) => `${i + 1}. [${v.title}](${v.url})`)
        .join('\n'),
    )
    .setFooter({ text: list.length > MAX_SHOWN ? `و${list.length - MAX_SHOWN} أخرى…` : `${list.length} فيديو` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
