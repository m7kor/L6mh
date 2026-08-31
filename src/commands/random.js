import { SlashCommandBuilder } from 'discord.js';
import { playRandom, attachNowPlayingMessage, getSessionInfo } from '../services/player.js';
import { buildNowPlayingEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('شيوائي')
  .setDescription('تشغيل مقاطع عشوائية بشكل مستمر (24/7)');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    const video = await playRandom(interaction.guild, voiceChannel);
    const info = getSessionInfo(interaction.guild.id);

    const embed = buildNowPlayingEmbed(video, {
      volume: info.volume,
      mode: info.mode,
      continuous: info.continuous,
      paused: info.paused,
      elapsedSeconds: info.elapsedSeconds,
    });

    const message = await interaction.editReply({ embeds: [embed] });
    attachNowPlayingMessage(interaction.guild.id, message);
  } catch (err) {
    await interaction.editReply(`❌ خطأ: ${err.message}`);
  }
}
