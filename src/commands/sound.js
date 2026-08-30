import { SlashCommandBuilder } from 'discord.js';
import { playSoundEffect } from '../services/player.js';
import { listSounds, resolveSoundPath } from '../utils/sounds.js';

export const data = new SlashCommandBuilder()
  .setName('sound')
  .setDescription('تشغيل مقطع صوتي قصير من مكتبة الأصوات')
  .addStringOption((opt) => opt
    .setName('name')
    .setDescription('اسم الصوت')
    .setRequired(true)
    .setAutocomplete(true));

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = listSounds()
    .filter((name) => name.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(matches.map((name) => ({ name, value: name })));
}

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
    return;
  }

  const name = interaction.options.getString('name', true);
  const filePath = resolveSoundPath(name);

  if (!filePath) {
    const available = listSounds();
    const hint = available.length
      ? `الأصوات المتاحة: ${available.slice(0, 10).join('، ')}`
      : 'مافي أصوات مضافة بعد — حط ملفات mp3/ogg/wav داخل مجلد /sounds.';
    await interaction.reply({ content: `❌ ما لقيت صوت بالاسم "${name}".\n${hint}`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await playSoundEffect(interaction.guild, voiceChannel, filePath);
    await interaction.editReply(`🔊 تم تشغيل: **${name}**`);
  } catch (err) {
    await interaction.editReply(`❌ خطأ: ${err.message}`);
  }
}
