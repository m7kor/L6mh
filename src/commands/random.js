import { SlashCommandBuilder } from 'discord.js';
import { playRandom } from '../services/player/index.js';
import { executePlayCommand } from './play-command.js';

export const data = new SlashCommandBuilder()
  .setName('عشوائي')
  .setDescription('تشغيل مقاطع عشوائيه بشكل مستمر (24/7)');

export async function execute(interaction) {
  await executePlayCommand(interaction, playRandom, 'عشوائي');
}
