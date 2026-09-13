import { SlashCommandBuilder } from 'discord.js';
import { stopPlayback } from '../services/player/index.js';
import { getSession } from '../services/session.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sleeptimer');
const timers = new Map();
const deadlines = new Map();

export const data = new SlashCommandBuilder()
  .setName('ساعة_نوم')
  .setDescription('مؤقت إيقاف التشغيل')
  .addIntegerOption(opt =>
    opt.setName('الدقائق')
      .setDescription('عدد الدقائق قبل الإيقاف (0 لإلغاء)')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(480)
  );

export async function execute(interaction) {
  const minutes = interaction.options.getInteger('الدقائق');
  const guildId = interaction.guildId;

  cancelTimer(guildId);

  if (minutes === 0) {
    await interaction.reply('⏰ تم إلغاء مؤقت النوم.');
    return;
  }

  const session = getSession(guildId);
  if (!session || !session.connection) {
    await interaction.reply({ content: '❌ البوت غير متصل.', ephemeral: true });
    return;
  }

  setTimer(guildId, minutes);
  await interaction.reply(`⏰ سيتم إيقاف التشغيل بعد ${minutes} دقيقة. للالغاء: /ساعة_نوم 0`);
}

export function setTimer(guildId: string, minutes: number): void {
  cancelTimer(guildId);
  const deadline = Date.now() + minutes * 60_000;
  deadlines.set(guildId, deadline);
  // Persist deadline in session for restart recovery
  try {
    const session = getSession(guildId);
    if (session) session.sleepDeadline = deadline;
  } catch {}
  const timer = setTimeout(async () => {
    timers.delete(guildId);
    deadlines.delete(guildId);
    try {
      const session = getSession(guildId);
      if (session) session.sleepDeadline = null;
    } catch {}
    try {
      await stopPlayback(guildId, { manual: true });
      logger.info(`Sleep timer triggered for guild ${guildId} after ${minutes}m`);
    } catch (e) {
      logger.error(`Sleep timer stop failed for guild ${guildId}:`, e);
    }
  }, minutes * 60_000);
  timers.set(guildId, timer);
}

export function cancelTimer(guildId: string): boolean {
  if (timers.has(guildId)) {
    clearTimeout(timers.get(guildId));
    timers.delete(guildId);
    deadlines.delete(guildId);
    try {
      const session = getSession(guildId);
      if (session) session.sleepDeadline = null;
    } catch {}
    return true;
  }
  return false;
}

export function restoreTimer(guildId: string, deadlineTs: number): void {
  const remaining = deadlineTs - Date.now();
  if (remaining <= 0) return; // already expired
  const minutes = Math.ceil(remaining / 60_000);
  logger.info(`Restoring sleep timer for guild ${guildId} (${minutes}m remaining)`);
  setTimer(guildId, minutes);
}

export function getRemainingMs(guildId: string): number {
  const deadline = deadlines.get(guildId);
  if (!deadline) return 0;
  const remaining = deadline - Date.now();
  if (remaining <= 0) { deadlines.delete(guildId); return 0; }
  return remaining;
}
