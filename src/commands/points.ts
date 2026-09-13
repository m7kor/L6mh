import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getBalance, getLevelInfo } from '../services/points.js';
import { CMD, getLevel, LEVELS } from '../lang.js';
import { getDb } from '../utils/database.js';

export const data = new SlashCommandBuilder()
  .setName('نقاطي')
  .setDescription('عرض رصيد نقاطك ومستواك');

export async function execute(interaction) {
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  const db = getDb();
  const stats = db.prepare(
    'SELECT minutes_present, sessions_count, points FROM member_stats WHERE user_id = ? AND guild_id = ?'
  ).get(userId, guildId) as any;

  if (!stats || stats.minutes_present === 0) {
    await interaction.reply({ content: CMD.points.noData, ephemeral: true });
    return;
  }

  const balance = stats.points || 0;
  const levelInfo = getLevel(balance);
  const nextLevel = LEVELS.find(l => l.minPoints > balance);
  const progress = nextLevel
    ? Math.round(((balance - levelInfo.minPoints) / (nextLevel.minPoints - levelInfo.minPoints)) * 100)
    : 100;

  const hours = Math.floor(stats.minutes_present / 60);
  const mins = stats.minutes_present % 60;

  const embed = new EmbedBuilder()
    .setColor(0x00E5FF)
    .setTitle('🪙 رصيد نقاطك')
    .setDescription(
      `**${levelInfo.emoji} ${levelInfo.name}**\n` +
      `النقاط: **${balance}** 🪙\n` +
      (nextLevel
        ? `التالي: **${nextLevel.name}** (${nextLevel.minPoints} نقطة) — ${progress}%`
        : `🏆 وصلت لأعلى مستوى!`)
    )
    .addFields(
      { name: '⏱️ وقت الاستماع', value: `${hours} ساعة ${mins} دقيقة`, inline: true },
      { name: '📊 الجلسات', value: `${stats.sessions_count}`, inline: true },
    )
    .setFooter({ text: 'اسمع أكثر لتجمع نقاط!' });

  await interaction.reply({ embeds: [embed] });
}
