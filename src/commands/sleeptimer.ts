import { SlashCommandBuilder } from 'discord.js';
import { stopPlayback } from '../services/player/index.js';
import { getSession } from '../services/session.js';

const timers = new Map();

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

  // Cancel existing timer
  if (timers.has(guildId)) {
    clearTimeout(timers.get(guildId));
    timers.delete(guildId);
  }

  if (minutes === 0) {
    await interaction.reply('⏰ تم إلغاء مؤقت النوم.');
    return;
  }

  const session = getSession(guildId);
  if (!session || !session.connection) {
    await interaction.reply({ content: '❌ البوت غير متصل.', ephemeral: true });
    return;
  }

  const timer = setTimeout(async () => {
    timers.delete(guildId);
    try {
      await stopPlayback(guildId, { manual: true });
    } catch {}
  }, minutes * 60_000);

  timers.set(guildId, timer);
  await interaction.reply(`⏰ سيتم إيقاف التشغيل بعد ${minutes} دقيقة. للالغاء: /ساعة_نوم 0`);
}

export function cancelTimer(guildId) {
  if (timers.has(guildId)) {
    clearTimeout(timers.get(guildId));
    timers.delete(guildId);
  }
}
