// @ts-nocheck
import { SlashCommandBuilder } from 'discord.js';
import { setVolume, getSessionInfo, connectAndPlay } from '../services/player/index.js';

export const data = new SlashCommandBuilder()
  .setName('صوت')
  .setDescription('ضبط مستوى الصوت')
  .addIntegerOption(opt =>
    opt.setName('المستوى')
      .setDescription('الصوت من 0 إلى 100')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(100)
  );

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  const level = interaction.options.getInteger('المستوى');

  try {
    const info = await getSessionInfo(interaction.guildId);
    if (!info) {
      await interaction.reply({ content: '❌ لا يوجد تشغيل حالي.', ephemeral: true });
      return;
    }

    setVolume(interaction.guildId, level, connectAndPlay);
    await interaction.reply(`🔊 تم ضبط الصوت على ${level}%`);
  } catch (err) {
    await interaction.reply(`❌ خطأ: ${err.message}`);
  }
}
