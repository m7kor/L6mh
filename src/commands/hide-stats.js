import { SlashCommandBuilder } from 'discord.js';
import { optOut } from '../services/community.js';

export const data = new SlashCommandBuilder()
  .setName('اخفاء_احصائياتي')
  .setDescription('إخفاء اسمك من لوحة الشرف العامة (opt-out)');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  try {
    optOut(userId, guildId);
    await interaction.editReply('✅ **تم إخفاء اسمك من لوحة الشرف العامة.** لن تظهر إحصائياتك للآخرين.');
  } catch (err) {
    await interaction.editReply('❌ حدث خطأ أثناء محاولة الإخفاء.');
  }
}
