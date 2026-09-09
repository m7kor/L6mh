import { SlashCommandBuilder } from 'discord.js';
import { getQueue } from '../services/player.js';
import { getVideos } from '../services/youtube.js';

export const data = new SlashCommandBuilder()
  .setName('قريب')
  .setDescription('عرض الـ 5 مقاطع القادمة في القائمة');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  const queue = getQueue(interaction.guild.id);
  if (!queue.length) {
    await interaction.reply({ content: '📭 القائمة فارغة.', ephemeral: true });
    return;
  }

  const catalog = await getVideos();
  const next5 = queue.slice(0, 5);
  const lines = next5.map((vid, i) => {
    const v = catalog.find(c => c.videoId === vid);
    return `${i + 1}. ${v ? v.title : vid}`;
  });

  await interaction.reply({
    content: `📋 **القادم (${Math.min(5, queue.length)} من ${queue.length}):**\n${lines.join('\n')}`,
    ephemeral: true,
  });
}
