import { SlashCommandBuilder } from 'discord.js';
import { getDb } from '../utils/database.js';
import { getVideos } from '../services/youtube.js';
import { playVideo } from '../services/player/index.js';

export const data = new SlashCommandBuilder()
  .setName('مفضلة')
  .setDescription('إدارة مقاطعك المفضلة')
  .addSubcommand(sub =>
    sub.setName('اضافة')
      .setDescription('اضافة مقطع للمفضلة')
      .addStringOption(opt =>
        opt.setName('الرقم')
          .setDescription('رقم المقطع في قائمة التشغيل (1-901)')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('حذف')
      .setDescription('حذف مقطع من المفضلة')
      .addStringOption(opt =>
        opt.setName('الرقم')
          .setDescription('رقم المقطع في قائمة التشغيل')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('قائمة')
      .setDescription('عرض مقاطعك المفضلة')
  )
  .addSubcommand(sub =>
    sub.setName('تشغيل')
      .setDescription('تشغيل مقطع عشوائي من المفضلة')
  );

export async function execute(interaction) {
  const userId = interaction.user.id;
  const db = getDb();
  const sub = interaction.options.getSubcommand();

  if (sub === 'اضافة') {
    const num = parseInt(interaction.options.getString('الرقم'));
    if (isNaN(num) || num < 1) {
      await interaction.reply({ content: '❌ أدخل رقم صحيح.', ephemeral: true });
      return;
    }
    const videos = await getVideos();
    const video = videos[num - 1];
    if (!video) {
      await interaction.reply({ content: `❌ رقم ${num} غير موجود (الحد الأقصى ${videos.length}).`, ephemeral: true });
      return;
    }
    try {
      db.prepare('INSERT OR IGNORE INTO favorites (user_id, video_id) VALUES (?, ?)').run(userId, video.videoId);
      await interaction.reply(`⭐ تمت اضافة **${video.title}** للمفضلة.`);
    } catch (err) {
      await interaction.reply(`❌ خطأ: ${err.message}`);
    }
  } else if (sub === 'حذف') {
    const num = parseInt(interaction.options.getString('الرقم'));
    if (isNaN(num) || num < 1) {
      await interaction.reply({ content: '❌ أدخل رقم صحيح.', ephemeral: true });
      return;
    }
    const videos = await getVideos();
    const video = videos[num - 1];
    if (!video) {
      await interaction.reply({ content: `❌ رقم ${num} غير موجود.`, ephemeral: true });
      return;
    }
    const info = db.prepare('DELETE FROM favorites WHERE user_id = ? AND video_id = ?').run(userId, video.videoId);
    if (info.changes > 0) {
      await interaction.reply(`🗑️ تمت ازالة **${video.title}** من المفضلة.`);
    } else {
      await interaction.reply({ content: '❌ هذا المقطع ليس في مفضلتك.', ephemeral: true });
    }
  } else if (sub === 'قائمة') {
    const favs = db.prepare('SELECT video_id, added_at FROM favorites WHERE user_id = ? ORDER BY added_at DESC').all(userId);
    if (favs.length === 0) {
      await interaction.reply({ content: '⭐ لا يوجد مقاطع في مفضلتك.', ephemeral: true });
      return;
    }
    const videos = await getVideos();
    const lines = favs.slice(0, 25).map((f, i) => {
      const video = videos.find(v => v.videoId === f.video_id);
      const pos = video ? videos.indexOf(video) + 1 : '?';
      return `${i + 1}. **${video?.title || f.video_id}** \`#${pos}\` [▶](https://youtu.be/${f.video_id})`;
    });
    const embed = {
      color: 0xFFD700,
      title: `⭐ مقاطعك المفضلة (${favs.length})`,
      description: lines.join('\n'),
      footer: favs.length > 25 ? { text: `و ${favs.length - 25} مقطع إضافي...` } : undefined,
    };
    await interaction.reply({ embeds: [embed] });
  } else if (sub === 'تشغيل') {
    const favs = db.prepare('SELECT video_id FROM favorites WHERE user_id = ?').all(userId);
    if (favs.length === 0) {
      await interaction.reply({ content: '⭐ لا يوجد مقاطع في مفضلتك.', ephemeral: true });
      return;
    }
    const videos = await getVideos();
    const randomFav = favs[Math.floor(Math.random() * favs.length)];
    const video = videos.find(v => v.videoId === randomFav.video_id);
    if (!video) {
      await interaction.reply({ content: '❌ المقطع المفضل لم يعد متاحاً.', ephemeral: true });
      return;
    }
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '❌ لازم تكون في قناة صوتية.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      await playVideo(interaction.guild, voiceChannel, video);
      await interaction.editReply(`⭐▶️ تشغيل **${video.title}** من المفضلة.`);
    } catch (err) {
      await interaction.editReply(`❌ خطأ: ${err.message}`);
    }
  }
}
