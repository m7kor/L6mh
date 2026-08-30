import { SlashCommandBuilder } from 'discord.js';
import { stopPlayback } from '../services/player.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('إيقاف التشغيل ومغادرة القناة الصوتية');

export async function execute(interaction) {
  try {
    stopPlayback(interaction.guild.id, { manual: true });
    await interaction.reply('⏹️ تم إيقاف التشغيل.');
  } catch (err) {
    await interaction.reply({ content: `❌ خطأ: ${err.message}`, ephemeral: true });
  }
}
