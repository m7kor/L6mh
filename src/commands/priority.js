/**
 * commands/priority.js — /افضل_مقطع
 * يُضيف فيديو يوتيوب كأول مقطع في الطابور مقابل 20 نقطة.
 */

import { SlashCommandBuilder } from 'discord.js';
import { getSession } from '../services/session.js';
import { getSessionInfo } from '../services/player/index.js';
import { getVideoDetails } from '../services/youtube.js';
import { getUserPoints, deductPoints } from '../services/community.js';
import { saveState } from '../services/session.js';
import { CMD } from '../lang.js';

const PRIORITY_COST = Number(process.env.PRIORITY_COST) || 20;

export const data = new SlashCommandBuilder()
  .setName('افضل_مقطع')
  .setDescription(`اختر المقطع القادم (يكلف ${PRIORITY_COST} نقطة)`)
  .addStringOption((opt) =>
    opt
      .setName('رابط')
      .setDescription('معرّف يوتيوب أو رابط المقطع (مثال: dQw4w9WgXcQ)')
      .setRequired(true),
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const session = getSessionInfo(interaction.guildId);
  if (!session.connected) {
    return interaction.editReply({ content: CMD.general.botNotInVoice });
  }

  // استخراج videoId من الإدخال (رابط أو معرّف مباشر)
  const input   = interaction.options.getString('رابط').trim();
  const idMatch = input.match(/(?:v=|youtu\.be\/|embed\/|\/v\/|^)([A-Za-z0-9_-]{11})/);
  const videoId = idMatch?.[1];

  if (!videoId) {
    return interaction.editReply({ content: CMD.priority.invalidId });
  }

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const balance = getUserPoints(userId, guildId);

  if (balance < PRIORITY_COST) {
    return interaction.editReply({
      content: CMD.priority.notEnoughPoints(PRIORITY_COST, balance),
    });
  }

  // جلب تفاصيل الفيديو
  let title = videoId;
  try {
    const details = await getVideoDetails(videoId);
    title = details?.title || videoId; // سيُعاد من كاش SQLite إذا كان موجوداً
  } catch {
    return interaction.editReply({ content: CMD.priority.fetchError });
  }

  // إضافة المقطع كأول عنصر في الطابور
  const guildSession = getSession(guildId);
  guildSession.queue.unshift(videoId);
  await saveState(guildSession);

  // خصم النقاط
  deductPoints(userId, guildId, PRIORITY_COST, 'priority_queue');

  return interaction.editReply({
    content: CMD.priority.added(title, PRIORITY_COST),
  });
}
