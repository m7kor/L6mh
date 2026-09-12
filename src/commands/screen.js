import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('شاشة')
  .setDescription('فتح شاشة الفيديو المزامنة مع جميع الأعضاء');

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x00E5FF)
    .setTitle('📺 شاشة الفيديو المزامنة')
    .setDescription(
      '影片 يوتيوب يشتغل متزامن حرفياً مع كل الأعضاء بالروム!\n\n'
      + '**كيف تفتحها:**\n'
      + '1. اضغط على **🚀 Activities** بأسفل قائمة القناة الصوتية\n'
      + '2. اختار **راديو وحيد عمر** من القائمة\n'
      + '3. الفيديو يفتح للكل اللي بنفس الروم!\n\n'
      + '💡 *ملاحظة: لازم عضو واحد يضغط الزر عشان يفتحها — هذا تصميم أمني من ديسكورد نفسه.*'
    )
    .setFooter({ text: 'راديو وحيد عمر 🎙️' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: false });
}
