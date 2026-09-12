const DJ_ROLE_ID = process.env.DJ_ROLE_ID || '';
export async function requireDjRole(interaction) {
    if (!DJ_ROLE_ID)
        return true;
    if (interaction.member.roles.cache.has(DJ_ROLE_ID))
        return true;
    await interaction.reply({ content: '❌ تحتاج رول DJ لاستخدام هذا الأمر.', ephemeral: true });
    return false;
}
