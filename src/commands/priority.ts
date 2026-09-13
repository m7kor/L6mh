import { SlashCommandBuilder } from 'discord.js';
import { spendPoints, PRIORITY_COST } from '../services/points.js';
import { getSession } from '../services/session.js';
import { getVideoDetails } from '../services/youtube.js';
import { CMD } from '../lang.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('priority');

export const data = new SlashCommandBuilder()
  .setName('افضل_مقطع')
  .setDescription('إضافة مقطع كأولوية عالية (يكلف نقاط)')
  .addStringOption(opt =>
    opt.setName('الفيديو')
      .setDescription('معرف فيديو يوتيوب (11 حرفاً)')
      .setRequired(true)
  );

export async function execute(interaction) {
  const videoId = interaction.options.getString('الفيديو')?.trim();
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    await interaction.reply({ content: CMD.priority.invalidId, ephemeral: true });
    return;
  }

  const result = spendPoints(userId, guildId, PRIORITY_COST, 'priority');
  if (!result.ok) {
    await interaction.reply({
      content: CMD.priority.notEnoughPoints(PRIORITY_COST, result.balance),
      ephemeral: true,
    });
    return;
  }

  const session = getSession(guildId);
  if (!session) {
    await interaction.reply({ content: '❌ البوت غير متصل.', ephemeral: true });
    return;
  }

  let title = videoId;
  try {
    const details = await getVideoDetails(videoId);
    if (details) title = details.title || videoId;
  } catch (err) {
    logger.warn(`Failed to fetch video details for ${videoId}: ${err.message}`);
  }

  // Insert at front of queue
  session.queue.unshift(videoId);

  await interaction.reply({
    content: CMD.priority.added(title, PRIORITY_COST),
    allowedMentions: { users: [] },
  });
}
