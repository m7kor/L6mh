import { SlashCommandBuilder } from 'discord.js';
import { playRandom, playLatest, attachNowPlayingMessage, getSessionInfo } from '../services/player.js';
import { buildNowPlayingEmbed, buildControlRow } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('تشغيل بث قناة وحيد عمر (يستمر 24/7 تلقائياً)')
  .addStringOption((opt) => opt
    .setName('mode')
    .setDescription('نقطة البداية')
    .addChoices(
      { name: 'آخر فيديو — الافتراضي', value: 'latest' },
      { name: 'عشوائي', value: 'random' },
    ));

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  const mode = interaction.options.getString('mode'); // 'latest' | 'random' | null

  await interaction.deferReply();

  try {
    const video = mode === 'random'
      ? await playRandom(interaction.guild, voiceChannel)
      : await playLatest(interaction.guild, voiceChannel);

    const info = getSessionInfo(interaction.guild.id);

    const embed = buildNowPlayingEmbed(video, {
      volume: info.volume,
      mode: info.mode,
      continuous: info.continuous,
      paused: info.paused,
      elapsedSeconds: info.elapsedSeconds,
    });
    const row = buildControlRow({ paused: info.paused });

    const message = await interaction.editReply({ embeds: [embed], components: [row] });
    attachNowPlayingMessage(interaction.guild.id, message);
  } catch (err) {
    await interaction.editReply(`❌ خطأ: ${err.message}`);
  }
}
