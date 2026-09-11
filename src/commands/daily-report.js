import { SlashCommandBuilder } from 'discord.js';
import { getDb } from '../utils/database.js';
import { getUserStats, getLeaderboard } from '../services/community.js';

export const data = new SlashCommandBuilder()
  .setName('تقرير')
  .setDescription('تقرير يومي: أكثر المقاطع تشغيلاً والمستمعون النشطون');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const db = getDb();
  const guildId = interaction.guild.id;

  // Get top played videos today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();

  const topPlayed = db.prepare(`
    SELECT video_id, title, COUNT(*) as cnt
    FROM plays
    WHERE guild_id = ? AND played_at >= ?
    GROUP BY video_id
    ORDER BY cnt DESC
    LIMIT 5
  `).all(guildId, todayStr);

  // Get leaderboard today
  const leaderboard = getLeaderboard(guildId, 5)
    .filter(e => e.minutes_present > 0)
    .map(e => ({
      userId: e.user_id,
      hours: Math.floor(e.minutes_present / 60),
      mins: e.minutes_present % 60,
    }));

  const lines = [];
  lines.push(`📊 **تقرير يومي — ${new Date().toLocaleDateString('ar-SA')}**`);
  lines.push(``);

  if (topPlayed.length) {
    lines.push(`🎵 **أكثر المقاطع تشغيلاً اليوم:**`);
    topPlayed.forEach((v, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      lines.push(`${medals[i] || `${i + 1}.`} **${v.title}** — ${v.cnt}×`);
    });
  } else {
    lines.push(`🎵 **لم تُشغَّل مقاطع اليوم**`);
  }

  lines.push('');

  if (leaderboard.length) {
    lines.push(`👥 **المستمعون النشطون اليوم:**`);
    leaderboard.forEach((e, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      lines.push(`${medals[i] || `${i + 1}.`} عضو#${e.userId.slice(-4)} — ${e.hours}س ${e.mins}د`);
    });
  } else {
    lines.push(`👥 **لا يوجد مستمعون نشطون اليوم**`);
  }

  lines.push('');
  lines.push(`💡 استخدم **/احصائياتي** لعرض إحصائياتك الشخصية`);

  await interaction.editReply(lines.join('\n'));
}
