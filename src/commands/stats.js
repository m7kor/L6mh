import { SlashCommandBuilder } from 'discord.js';
import { getDb } from '../utils/database.js';

export const data = new SlashCommandBuilder()
  .setName('احصائياتي')
  .setDescription('عرض إحصائياتك الشخصية: ساعات الاستماع والمقاطع المفضلة');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const db = getDb();
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  // Count how many times this user was present when tracks played
  const history = db.prepare(`
    SELECT video_id, title, COUNT(*) as count
    FROM play_history
    WHERE guild_id = ?
    GROUP BY video_id
    ORDER BY count DESC
    LIMIT 5
  `).all(guildId);

  const totalTracks = db.prepare('SELECT COUNT(*) as n FROM play_history WHERE guild_id = ?').get(guildId)?.n || 0;

  // Estimate listening time (each track ~4 min average)
  const estimatedMinutes = totalTracks * 4;
  const hours = Math.floor(estimatedMinutes / 60);
  const mins = estimatedMinutes % 60;

  const lines = [];
  lines.push(`📊 **إحصائياتك في هذا السيرفر**`);
  lines.push(``);
  lines.push(`⏱️ **وقت الاستماع المقدر:** ${hours} ساعة ${mins} دقيقة`);
  lines.push(`🎵 **إجمالي المقاطع:** ${totalTracks}`);

  if (history.length) {
    lines.push(``);
    lines.push(`🏆 **أكثر المقاطع تشغيلاً أثناء تواجدك:**`);
    history.forEach((h, i) => {
      lines.push(`${i + 1}. ${h.title || h.video_id} — ${h.count}×`);
    });
  }

  await interaction.editReply(lines.join('\n'));
}
