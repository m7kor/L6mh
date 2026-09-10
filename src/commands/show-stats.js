import { SlashCommandBuilder } from 'discord.js';
import { optIn, getUserStats } from '../services/community.js';

export const data = new SlashCommandBuilder()
  .setName('اظهار_احصائياتي')
  .setDescription('إظهار اسمك في لوحة الشرف العامة (التراجع عن الإخفاء)');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  try {
    optIn(userId, guildId);
    const stats = getUserStats(userId, guildId);
    const hours = Math.floor(stats.minutes_present / 60);
    const mins = stats.minutes_present % 60;
    await interaction.editReply(
      `✅ **تم إظهار اسمك في لوحة الشرف العامة.**\n` +
      `📊 ساعاتك المتراكمة: ${hours} ساعة ${mins} دقيقة`
    );
  } catch (err) {
    await interaction.editReply('❌ حدث خطأ أثناء محاولة الإظهار.');
  }
}
