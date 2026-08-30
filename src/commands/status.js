import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSessionInfo } from '../services/player.js';
import { config } from '../config.js';
import { formatTime } from '../utils/embeds.js';

const execFileAsync = promisify(execFile);

async function toolVersion(cmd, args = ['--version']) {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return stdout.trim().split('\n')[0];
  } catch {
    return '❌ غير موجود';
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}ي`);
  if (h) parts.push(`${h}س`);
  parts.push(`${m}د`);
  return parts.join(' ');
}

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('عرض حالة تشغيل البوت (تشخيص)');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const info = getSessionInfo(interaction.guild.id);
  const [ytdlpVersion, ffmpegVersion] = await Promise.all([
    toolVersion('yt-dlp'),
    toolVersion('ffmpeg'),
  ]);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('🔧 حالة البوت')
    .addFields(
      { name: 'الاتصال الصوتي', value: info.connected ? '✅ متصل' : '⭕ غير متصل', inline: true },
      { name: 'الوضع', value: info.mode ? `${info.mode}${info.paused ? ' (متوقف مؤقتاً)' : ''}` : '—', inline: true },
      { name: 'مستوى الصوت', value: `${info.volume}%`, inline: true },
      { name: 'مدة تشغيل العملية', value: formatUptime(process.uptime()), inline: true },
      { name: 'استهلاك الذاكرة', value: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`, inline: true },
      { name: 'القناة المصدر', value: `\`${config.channelId}\``, inline: true },
      { name: 'yt-dlp', value: ytdlpVersion, inline: true },
      { name: 'ffmpeg', value: ffmpegVersion.split(' ').slice(0, 3).join(' '), inline: true },
    );

  if (info.current) {
    embed.setDescription(
      `**يشغل الآن:** [${info.current.title}](${info.current.url})\n`
      + `${formatTime(info.elapsedSeconds)} / ${info.current.durationSeconds ? formatTime(info.current.durationSeconds) : '؟'}`,
    );
  }

  await interaction.editReply({ embeds: [embed] });
}
