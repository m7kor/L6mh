import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getSessionInfo, getAllSessions, connectAndPlay } from '../services/player/index.js';
import { getSession, saveState } from '../services/session.js';

export const data = new SlashCommandBuilder()
  .setName('اعدادات')
  .setDescription('عرض وإعدادات البوت')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName('عرض')
      .setDescription('عرض الإعدادات الحالية')
  )
  .addSubcommand(sub =>
    sub.setName('صوت')
      .setDescription('ضبط الصوت الافتراضي')
      .addIntegerOption(opt =>
        opt.setName('المستوى')
          .setDescription('الصوت من 0 إلى 100')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'عرض') {
    const info = getSessionInfo(interaction.guildId);
    if (!info) {
      await interaction.reply({ content: '❌ لا يوجد تشغيل حالي.', ephemeral: true });
      return;
    }

    const embed = {
      color: 0x00E5FF,
      title: '⚙️ إعدادات البوت',
      fields: [
        { name: 'الصوت', value: `${Math.round((info.volume || 1) * 100)}%`, inline: true },
        { name: 'الحالة', value: info.paused ? '⏸️ متوقف مؤقتاً' : '▶️ يعمل', inline: true },
        { name: 'الوضع', value: info.mode === 'random' ? 'عشوائي مستمر' : info.mode === 'latest' ? 'آخر مقطع' : 'استكمال', inline: true },
        { name: 'متصل', value: info.connected ? '✅' : '❌', inline: true },
        { name: 'القناة', value: info.queueCount !== undefined ? `${info.queueCount} مقطع في الطابور` : '—', inline: true },
      ],
    };

    await interaction.reply({ embeds: [embed] });
  } else if (sub === 'صوت') {
    const level = interaction.options.getInteger('المستوى');
    const session = getSession(interaction.guildId);
    if (!session || !session.connection) {
      await interaction.reply({ content: '❌ البوت غير متصل.', ephemeral: true });
      return;
    }

    const { setVolume } = await import('../services/player/controls.js');
    setVolume(interaction.guildId, level, connectAndPlay);
    await interaction.reply(`🔊 تم ضبط الصوت على ${level}%`);
  }
}
