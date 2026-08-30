import { SlashCommandBuilder } from 'discord.js';
import { getSessionInfo, attachNowPlayingMessage } from '../services/player.js';
import { buildNowPlayingEmbed, buildControlRow } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('عرض بطاقة التشغيل الحالية مع أزرار التحكم');

export async function execute(interaction) {
  const info = getSessionInfo(interaction.guild.id);

  if (!info.current) {
    await interaction.reply({ content: 'لا يوجد شيء قيد التشغيل حالياً.', ephemeral: true });
    return;
  }

  const embed = buildNowPlayingEmbed(info.current, info);
  const row = buildControlRow({ paused: info.paused });

  const message = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
  attachNowPlayingMessage(interaction.guild.id, message);
}
