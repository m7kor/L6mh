import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getQueue, getSessionInfo } from '../services/player/index.js';
import { getCachedTitleMap } from '../services/youtube.js';
export const data = new SlashCommandBuilder()
    .setName('قائمة')
    .setDescription('عرض مقاطع التشغيل القادمة');
export async function execute(interaction) {
    const guildId = interaction.guildId;
    const queue = getQueue(guildId);
    const info = getSessionInfo(guildId);
    if (!info.connected) {
        await interaction.reply({ content: '❌ البوت غير متصل بأي روم صوتي.', ephemeral: true });
        return;
    }
    if (queue.length === 0) {
        await interaction.reply({ content: '📭 القائمة فاضية.', ephemeral: true });
        return;
    }
    const titleMap = getCachedTitleMap();
    const rows = queue.slice(0, 50).map((vidId, idx) => {
        const title = titleMap.get(vidId) || vidId;
        const num = idx + 1;
        return `\`${num}.\` ${title}`;
    });
    const embed = new EmbedBuilder()
        .setColor(0x00E5FF)
        .setTitle('📋 قائمة التشغيل القادمة')
        .setDescription(rows.join('\n'))
        .setFooter({ text: `${queue.length} مقطع في القائمة${queue.length > 50 ? ` (عرض 50 من ${queue.length})` : ''}` })
        .setTimestamp();
    if (info.current?.thumbnail) {
        embed.setThumbnail(info.current.thumbnail);
    }
    await interaction.reply({ embeds: [embed] });
}
