import { SlashCommandBuilder } from 'discord.js';
import { skipTrack, getSessionInfo } from '../services/player/controls.js';
import { spendPoints, SKIP_COST } from '../services/points.js';
import { checkBadges } from '../services/community.js';
import { CMD } from '../lang.js';

export const data = new SlashCommandBuilder()
  .setName('تخطي')
  .setDescription('تخطي المقطع الحالي (يكلف نقاط)');

export async function execute(interaction) {
  const info = getSessionInfo(interaction.guildId);
  if (!info || !info.current?.title) {
    await interaction.reply({ content: CMD.skip.notPlaying, ephemeral: true });
    return;
  }

  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  const result = spendPoints(userId, guildId, SKIP_COST, 'skip');
  if (!result.ok) {
    await interaction.reply({
      content: CMD.skip.notEnoughPoints(SKIP_COST, result.balance),
      ephemeral: true,
    });
    return;
  }

  const title = info.current?.title || '—';
  skipTrack(guildId);

  // Award skipper badge on first skip
  checkBadges(userId, guildId);

  await interaction.reply({
    content: CMD.skip.skipped(title, SKIP_COST),
    allowedMentions: { users: [] },
  });
}
