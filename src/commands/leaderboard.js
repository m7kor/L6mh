import { SlashCommandBuilder } from 'discord.js';
import { getLeaderboard } from '../services/community.js';

export const data = new SlashCommandBuilder()
  .setName('المتصدرين')
  .setDescription('عرض لوحة المتصدرين الشهرية —أكثر الأعضاء استماعاً');

export async function execute(interaction) {
  await interaction.deferReply();

  const guildId = interaction.guild.id;
  const top = getLeaderboard(guildId, 10);

  if (!top.length) {
    await interaction.editReply('📊 **لا توجد بيانات بعد** — ابدأ بالاستماع لتظهر في اللوحة!');
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = [];
  lines.push('🏆 **لوحة المتصدرين — أعلى ١٠ by ساعات الاستماع**');
  lines.push('');

  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    const hours = Math.floor(entry.minutes_present / 60);
    const mins = entry.minutes_present % 60;
    const prefix = medals[i] || `**${i + 1}.**`;
    let display;
    try {
      const member = await interaction.guild.members.fetch(entry.user_id);
      display = member.displayName;
    } catch {
      display = `عضو#${entry.user_id.slice(-4)}`;
    }
    lines.push(`${prefix} **${display}** — ${hours}س ${mins}د`);
  }

  await interaction.editReply(lines.join('\n'));
}
