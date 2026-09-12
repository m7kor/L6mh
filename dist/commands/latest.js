import { SlashCommandBuilder } from 'discord.js';
import { playLatest } from '../services/player/index.js';
import { executePlayCommand } from './play-command.js';
export const data = new SlashCommandBuilder()
    .setName('اخر_مقطع')
    .setDescription('تشغيل احدث مقطع من القناة');
export async function execute(interaction) {
    await executePlayCommand(interaction, playLatest, 'اخر_مقطع');
}
