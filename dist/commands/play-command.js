// @ts-nocheck
import { buildNowPlayingMessage } from '../utils/embeds.js';
import { isOnCooldown, setCooldown, getRemainingCooldown } from '../utils/cooldown.js';
import { requireDjRole } from '../utils/permissions.js';
import { attachNowPlayingMessage, getSessionInfo } from '../services/player/index.js';
export async function executePlayCommand(interaction, playFn, commandName) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
        await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
        return;
    }
    if (!(await requireDjRole(interaction)))
        return;
    if (isOnCooldown(interaction.user.id, commandName)) {
        const secs = getRemainingCooldown(interaction.user.id, commandName);
        await interaction.reply({ content: `⏳ انتظر ${secs} ثانية قبل إعادة المحاولة.`, ephemeral: true });
        return;
    }
    setCooldown(interaction.user.id, commandName);
    await interaction.deferReply();
    try {
        const video = await playFn(interaction.guild, voiceChannel);
        const info = getSessionInfo(interaction.guild.id);
        const msg = buildNowPlayingMessage(video, {
            volume: info.volume,
            mode: info.mode,
            continuous: info.continuous,
            paused: info.paused,
            elapsedSeconds: info.elapsedSeconds,
        });
        const message = await interaction.editReply(msg);
        attachNowPlayingMessage(interaction.guild.id, message);
    }
    catch (err) {
        await interaction.editReply(`❌ خطأ: ${err.message}`);
    }
}
