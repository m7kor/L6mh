import { SlashCommandBuilder } from 'discord.js';
import { getSessionInfo } from '../services/player/index.js';

export const data = new SlashCommandBuilder()
  .setName('حالة')
  .setDescription('عرض حالة البوت: الاتصال، الذاكرة، وقت التشغيل');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const session = getSessionInfo(interaction.guild.id);
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const lines = [];
  lines.push(`🔍 **حالة البوت**`);
  lines.push(``);
  lines.push(`⏱️ **وقت التشغيل:** ${hours} ساعة ${mins} دقيقة`);
  lines.push(`💾 **الذاكرة:** ${mem} MB`);
  lines.push(`🔌 **الاتصال:** ${session.connected ? '✅ متصل' : '❌ غير متصل'}`);
  lines.push(`📺 **السيرفر:** ${interaction.guild.name}`);
  if (session.title) {
    lines.push(`🎵 **الآن يُشغّل:** ${session.title}`);
    lines.push(`⏱️ **الوقت:** ${Math.floor(session.elapsedSeconds / 60)}:${String(session.elapsedSeconds % 60).padStart(2, '0')}`);
    lines.push(`📊 **الوضع:** ${session.mode === 'random' ? 'عشوائي' : session.mode === 'latest' ? 'آخر مقطع' : 'استكمال'}`);
    lines.push(`🔄 **المقاطع المنقاة:** ${session.queueCount}`);
  } else {
    lines.push(`🎵 **لا يُشغّل أي شيء**`);
  }

  await interaction.editReply(lines.join('\n'));
}
