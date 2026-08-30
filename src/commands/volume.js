import { SlashCommandBuilder } from 'discord.js';
import { setVolume } from '../services/player.js';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('ضبط مستوى الصوت (0-200%)')
  .addIntegerOption((opt) => opt
    .setName('percent')
    .setDescription('النسبة المئوية لمستوى الصوت')
    .setMinValue(0)
    .setMaxValue(200)
    .setRequired(true));

export async function execute(interaction) {
  const percent = interaction.options.getInteger('percent', true);
  try {
    const applied = setVolume(interaction.guild.id, percent);
    await interaction.reply({ content: `🔊 مستوى الصوت الآن: ${applied}%`, ephemeral: true });
  } catch (err) {
    await interaction.reply({ content: `❌ خطأ: ${err.message}`, ephemeral: true });
  }
}
