import { SlashCommandBuilder } from 'discord.js';
import { getDb } from '../utils/database.js';
import { getUserBadges, getUserStats } from '../services/community.js';

export const data = new SlashCommandBuilder()
  .setName('احصائياتي')
  .setDescription('عرض إحصائياتك الشخصية: ساعات الاستماع والأوسمة');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const db = getDb();
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  const stats = getUserStats(userId, guildId);
  const badges = getUserBadges(userId, guildId);
  const hours = Math.floor(stats.minutes_present / 60);
  const mins = stats.minutes_present % 60;

  const lines = [];
  lines.push(`📊 **إحصائياتك في هذا السيرفر**`);
  lines.push(``);
  lines.push(`⏱️ **وقت الاستماع:** ${hours} ساعة ${mins} دقيقة`);
  lines.push(`🎧 **عدد الجلسات:** ${stats.sessions_count}`);

  if (badges.length) {
    lines.push('');
    lines.push(`🏅 **أوسمتك:**`);
    badges.forEach(b => {
      lines.push(`${b.emoji} **${b.name}** — ${b.desc}`);
    });
  } else {
    lines.push('');
    lines.push(`🏅 **لم تحصل على أي وسم بعد** — استمر بالاستماع!`);
  }

  await interaction.editReply(lines.join('\n'));
}
