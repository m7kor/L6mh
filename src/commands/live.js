/**
 * commands/live.js — /بث
 * يبدأ بث مباشر من رابط يوتيوب في القناة الصوتية الحالية.
 * البث المباشر لا ينتهي تلقائياً — يُوقف بـ /وقف_البث.
 */

import { SlashCommandBuilder } from 'discord.js';
import { playVideo } from '../services/player/index.js';
import { isLiveStream } from '../services/streaming.js';
import { getVideoDetails } from '../services/youtube.js';
import { CMD } from '../lang.js';

// التحقق من صحة الرابط
function extractVideoId(input) {
  const m = input.match(/(?:v=|youtu\.be\/|embed\/|\/v\/|^)([A-Za-z0-9_-]{11})/);
  return m?.[1] || null;
}

export const data = new SlashCommandBuilder()
  .setName('بث')
  .setDescription('ابدأ بث مباشر من يوتيوب في الروم الصوتي')
  .addStringOption((opt) =>
    opt
      .setName('رابط')
      .setDescription('رابط البث المباشر على يوتيوب')
      .setRequired(true),
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const input   = interaction.options.getString('رابط').trim();
  const videoId = extractVideoId(input);

  if (!videoId) {
    return interaction.editReply({ content: CMD.live.invalidUrl });
  }

  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return interaction.editReply({ content: CMD.general.notInVoice });
  }

  await interaction.editReply({ content: CMD.live.starting });

  const url   = `https://www.youtube.com/watch?v=${videoId}`;
  const live  = await isLiveStream(url).catch(() => false);

  if (!live) {
    return interaction.editReply({ content: CMD.live.notLive });
  }

  try {
    let title = videoId;
    try {
      const details = await getVideoDetails(videoId);
      title = details?.title || videoId;
    } catch {}

    const video = {
      videoId,
      title,
      url,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      durationSeconds: null, // بث مباشر — لا مدة محددة
      isLive: true,
    };

    await playVideo(interaction.guild, channel, video);
    return interaction.editReply({ content: CMD.live.started(title) });
  } catch (err) {
    return interaction.editReply({ content: CMD.live.error });
  }
}
