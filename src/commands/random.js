import { SlashCommandBuilder } from 'discord.js';
import { playRandom } from '../services/player.js';

export const data = new SlashCommandBuilder()
  .setName('random')
  .setDescription('تشغيل مقاطع عشوائية بشكل مستمر (24/7)');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    playRandom(interaction.guild, voiceChannel).catch((err) =>
      console.error('[random] Error:', err),
    );
    await interaction.editReply('🎲 جاري تشغيل مقاطع عشوائية بشكل مستمر…');
  } catch (err) {
    await interaction.editReply(`❌ خطأ: ${err.message}`);
  }
}
