import { SlashCommandBuilder } from 'discord.js';
import { getVideos } from '../services/youtube.js';

export const data = new SlashCommandBuilder()
  .setName('بحث')
  .setDescription('البحث عن مقطع في قائمة التشغيل')
  .addStringOption(opt =>
    opt.setName('الاستعلام')
      .setDescription('الكلمة أو العدد المراد البحث عنه')
      .setRequired(true)
  );

export async function execute(interaction) {
  const query = interaction.options.getString('الاستعلام');
  if (!query) {
    await interaction.reply({ content: '❌ أدخل كلمة للبحث.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  try {
    const videos = await getVideos();
    const q = query.toLowerCase();

    const matches = videos.filter(v =>
      (v.title || '').toLowerCase().includes(q) ||
      v.videoId.toLowerCase().includes(q)
    ).slice(0, 20);

    if (matches.length === 0) {
      await interaction.editReply(`🔍 لا توجد نتائج لـ **${query}**`);
      return;
    }

    const lines = matches.map((v, i) => {
      const pos = videos.indexOf(v) + 1;
      return `${i + 1}. **${v.title || '—'}** \`#${pos}\` [▶](https://youtu.be/${v.videoId})`;
    });

    const embed = {
      color: 0x00E5FF,
      title: `🔍 نتائج البحث: ${query}`,
      description: lines.join('\n'),
      footer: { text: `${matches.length} نتيجة من ${videos.length} مقطع` },
      timestamp: new Date().toISOString(),
    };

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(`❌ خطأ: ${err.message}`);
  }
}
