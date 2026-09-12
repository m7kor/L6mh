import { SlashCommandBuilder } from 'discord.js';
import { resume } from '../services/player/index.js';
import { executePlayCommand } from './play-command.js';

export const data = new SlashCommandBuilder()
  .setName('كمل')
  .setDescription('استكمال اخر مقطع تم تشغيله');

export async function execute(interaction) {
  await executePlayCommand(interaction, resume, 'كمل');
}
