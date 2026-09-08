import { SlashCommandBuilder } from 'discord.js';
import { playRandom, attachNowPlayingMessage, getSessionInfo } from '../services/player.js';
import { buildNowPlayingEmbed } from '../utils/embeds.js';
import { isOnCooldown, setCooldown, getRemainingCooldown } from '../utils/cooldown.js';

export const data = new SlashCommandBuilder()
  .setName('عشوائي')
  .setDescription('تشغيل مقاطع عشوائيه بشكل مستمر (24/7)');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  if (isOnCooldown(interaction.user.id, 'عشوائي')) {
    const secs = getRemainingCooldown(interaction.user.id, 'عشوائي');
    await interaction.reply({ content: `⏳ انتظر ${secs} ثانية قبل إعادة المحاولة.`, ephemeral: true });
    return;
  }

  setCooldown(interaction.user.id, 'عشوائي');
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
