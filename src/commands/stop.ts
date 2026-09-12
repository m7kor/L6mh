import { SlashCommandBuilder } from 'discord.js';
import { stopPlayback } from '../services/player/index.js';

export const data = new SlashCommandBuilder()
  .setName('ايقاف')
  .setDescription('إيقاف التشغيل وفصل البوت من القناة الصوتية');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  const botChannel = interaction.guild.members.me?.voice?.channel;
  if (!botChannel) {
    await interaction.reply({ content: '❌ البوت غير متصل بأي قناة صوتية.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    await stopPlayback(interaction.guildId, { manual: true });
    await interaction.editReply('⏹️ تم إيقاف التشغيل وفصل البوت من القناة.');
  } catch (err) {
    await interaction.editReply(`❌ خطأ: ${err.message}`);
  }
}
