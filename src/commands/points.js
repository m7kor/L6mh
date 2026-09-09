/**
 * commands/points.js — /نقاطي
 * يعرض رصيد نقاط المستخدم ومستواه وأوسمته.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getUserPoints, getUserStats, getUserBadges } from '../services/community.js';
import { getLevel, CMD, LEVELS } from '../lang.js';

export const data = new SlashCommandBuilder()
  .setName('نقاطي')
  .setDescription('اعرف رصيد نقاطك ومستواك الحالي');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;

  const stats  = getUserStats(userId, guildId);
  const badges = getUserBadges(userId, guildId);
  const points = stats.points ?? getUserPoints(userId, guildId);

  if (!stats || stats.sessions_count === 0) {
    return interaction.editReply({ content: CMD.points.noData });
  }

  const level    = getLevel(points);
  const nextLvl  = LEVELS.find((l) => l.minPoints > points);
  const toNext   = nextLvl ? nextLvl.minPoints - points : null;
  const hours    = Math.floor(stats.minutes_present / 60);
  const mins     = stats.minutes_present % 60;

  const badgeText = badges.length > 0
    ? badges.map((b) => `${b.emoji} **${b.name}**`).join('  ')
    : '—';

  const nextText = toNext !== null
    ? `\nللوصول لـ ${LEVELS.find((l) => l.minPoints > points)?.emoji} **${LEVELS.find((l) => l.minPoints > points)?.name}**: تحتاج **${toNext}** نقطة أخرى`
    : '\nأنت في أعلى مستوى! 💎';

  const embed = new EmbedBuilder()
    .setColor(0x00E5FF)
    .setTitle(`${CMD.points.title} — ${interaction.user.displayName}`)
    .setThumbnail(interaction.user.displayAvatarURL())
    .addFields(
      { name: '🪙 الرصيد',   value: `**${points}** نقطة`,                    inline: true },
      { name: '📊 المستوى',  value: `${level.emoji} **${level.name}**`,        inline: true },
      { name: '⏱️ ساعات الاستماع', value: `**${hours}** ساعة و **${mins}** دقيقة`, inline: true },
      { name: '🎭 الجلسات',  value: `**${stats.sessions_count}** جلسة`,       inline: true },
      { name: '🏅 الأوسمة',  value: badgeText,                                inline: false },
    )
    .setFooter({ text: `1 نقطة كل 15 دقيقة استماع${nextText}` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
