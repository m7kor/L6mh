import { SlashCommandBuilder } from 'discord.js';
import { playLatest, attachNowPlayingMessage, getSessionInfo } from '../services/player/index.js';
import { buildNowPlayingMessage } from '../utils/embeds.js';
import { isOnCooldown, setCooldown, getRemainingCooldown } from '../utils/cooldown.js';
import { requireDjRole } from '../utils/permissions.js';

export const data = new SlashCommandBuilder()
  .setName('اخر_مقطع')
  .setDescription('تشغيل اخر فيديو من القناه');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  if (!(await requireDjRole(interaction))) return;

  if (isOnCooldown(interaction.user.id, 'اخر_مقطع')) {
    const secs = getRemainingCooldown(interaction.user.id, 'اخر_مقطع');
    await interaction.reply({ content: `⏳ انتظر ${secs} ثانية قبل إعادة المحاولة.`, ephemeral: true });
    return;
  }

  setCooldown(interaction.user.id, 'اخر_مقطع');
  await interaction.deferReply();
  try {
    const video = await playLatest(interaction.guild, voiceChannel);
    const info = getSessionInfo(interaction.guild.id);

    const msg = buildNowPlayingMessage(video, {
      volume: info.volume,
      mode: info.mode,
      continuous: info.continuous,
      paused: info.paused,
      elapsedSeconds: info.elapsedSeconds,
    });

    const message = await interaction.editReply(msg);
    attachNowPlayingMessage(interaction.guild.id, message);
  } catch (err) {
    await interaction.editReply(`❌ خطأ: ${err.message}`);
  }
}
