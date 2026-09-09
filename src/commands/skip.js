/**
 * commands/skip.js — /تخطي
 * يخصم 10 نقاط ويتخطى المقطع الحالي.
 */

import { SlashCommandBuilder } from 'discord.js';
import { skipTrack, getSessionInfo } from '../services/player/index.js';
import { getUserPoints, deductPoints } from '../services/community.js';
import { CMD } from '../lang.js';

const SKIP_COST = Number(process.env.SKIP_COST) || 10;

export const data = new SlashCommandBuilder()
  .setName('تخطي')
  .setDescription(`تخطي المقطع الحالي (يكلف ${SKIP_COST} نقطة)`);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const session = getSessionInfo(interaction.guildId);
  if (!session.connected || !session.current) {
    return interaction.editReply({ content: CMD.skip.notPlaying });
  }

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const balance = getUserPoints(userId, guildId);

  if (balance < SKIP_COST) {
    return interaction.editReply({
      content: CMD.skip.notEnoughPoints(SKIP_COST, balance),
    });
  }

  const title = session.current?.title || '—';
  deductPoints(userId, guildId, SKIP_COST, 'skip');
  skipTrack(guildId);

  return interaction.editReply({
    content: CMD.skip.skipped(title, SKIP_COST),
  });
}
