import { SlashCommandBuilder } from 'discord.js';
import { execFile } from 'node:child_process';
import { getActiveProvider } from '../services/streaming.js';

export const data = new SlashCommandBuilder()
  .setName('اختبر')
  .setDescription('اختبار اتصال yt-dlp و PoT provider');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const results = [];

  // Test yt-dlp
  await new Promise(resolve => {
    execFile('yt-dlp', ['--version'], { timeout: 10000 }, (err, stdout) => {
      results.push(err ? `❌ yt-dlp: ${err.message}` : `✅ yt-dlp: ${stdout.trim()}`);
      resolve();
    });
  });

  // Test PoT provider
  const provider = getActiveProvider();
  await new Promise(resolve => {
    execFile('yt-dlp', [
      '--extractor-args', `youtubepot-bgutilhttp:base_url=${provider}`,
      '--simulate', '--print', 'title',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.includes('ECONNREFUSED') || stderr?.includes('connection refused')
          ? '❌ PoT provider: غير متاح'
          : `❌ PoT: ${err.message}`;
        results.push(msg);
      } else {
        results.push(`✅ PoT provider: متاح (${provider})`);
      }
      resolve();
    });
  });

  await interaction.editReply(results.join('\n'));
}
