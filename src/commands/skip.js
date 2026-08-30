import { SlashCommandBuilder } from 'discord.js';
import { skip } from '../services/player.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('تخطي المقطع الحالي');

export async function execute(interaction) {
  try {
    skip(interaction.guild.id);
    await interaction.reply({ content: '⏭️ تم التخطي.', ephemeral: true });
  } catch (err) {
    await interaction.reply({ content: `❌ خطأ: ${err.message}`, ephemeral: true });
  }
}
