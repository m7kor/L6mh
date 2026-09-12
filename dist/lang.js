/**
 * lang.js — ملف النصوص المركزي لبوت راديو وحيد عمر.
 *
 * جميع النصوص الظاهرة للمستخدم (عربية وإنجليزية) مُجمَّعة هنا.
 * بدلاً من نصوص مدمجة (Hardcoded) مبعثرة في عشرات الملفات،
 * يستورد كل ملف ما يحتاجه من هنا.
 */
// ---------------------------------------------------------------------------
// أوسمة المجتمع
// ---------------------------------------------------------------------------
export const BADGES = {
    first_join: { id: 'first_join', name: 'مستمع دائم', emoji: '🎧', desc: 'أول انضمام للروم الصوتي' },
    hours_10: { id: 'hours_10', name: 'لا يفوّت شي', emoji: '🔥', desc: '١٠ ساعات استماع تراكمية' },
    hours_50: { id: 'hours_50', name: 'نجم الروم', emoji: '⭐', desc: '٥٠ ساعة استماع تراكمية' },
    hours_100: { id: 'hours_100', name: 'محترف', emoji: '🏆', desc: '١٠٠ ساعة استماع تراكمية' },
    night_owl: { id: 'night_owl', name: 'سهران', emoji: '🌙', desc: 'حضور متكرر بعد الساعة ١٢ ليلاً' },
    dawn_guard: { id: 'dawn_guard', name: 'الفجر', emoji: '🌅', desc: 'حضور بعد الساعة ٤ صباحاً' },
    loyal: { id: 'loyal', name: 'وفي', emoji: '🌟', desc: '٧ أيام متتالية في الروم' },
    skipper: { id: 'skipper', name: 'منادي', emoji: '🎤', desc: 'استخدم التخطي لأول مرة' },
    addict: { id: 'addict', name: 'مدمن', emoji: '🎵', desc: 'تجاوز ٢٠٠ جلسة استماع' },
};
// ---------------------------------------------------------------------------
// مستويات النقاط
// ---------------------------------------------------------------------------
export const LEVELS = [
    { id: 'beginner', name: 'مبتدئ', emoji: '🥉', minPoints: 0 },
    { id: 'listener', name: 'مستمع', emoji: '🥈', minPoints: 50 },
    { id: 'loyal', name: 'مخلص', emoji: '🥇', minPoints: 200 },
    { id: 'legend', name: 'أسطورة', emoji: '💎', minPoints: 500 },
];
/**
 * يرجع مستوى المستخدم بناءً على نقاطه.
 * @param {number} points
 */
export function getLevel(points) {
    let current = LEVELS[0];
    for (const lvl of LEVELS) {
        if (points >= lvl.minPoints)
            current = lvl;
    }
    return current;
}
// ---------------------------------------------------------------------------
// تسميات أوضاع التشغيل (للـ embeds)
// ---------------------------------------------------------------------------
export const MODE_LABELS = {
    random: '🎲 عشوائي مستمر',
    latest: '🆕 آخر إصدار',
    url: '🎯 طلب خاص',
    manual: '🎯 طلب خاص',
    resume: '🔄 استكمال',
    live: '📡 بث مباشر',
};
// ---------------------------------------------------------------------------
// رسائل الخطأ (للمشغل والبث)
// ---------------------------------------------------------------------------
export const ERRORS = {
    voiceConnect: 'تعذّر الاتصال بالقناة الصوتية',
    noResume: 'لا يوجد مقطع سابق للاستكمال.',
    noChannelFound: 'القناة الصوتية غير متاحة.',
    ytdlpFailed: (code, detail = '') => `yt-dlp خرج بكود ${code}${detail}`,
    ffmpegFailed: (code, detail = '') => `ffmpeg خرج بكود ${code} قبل إنتاج الصوت${detail}`,
    streamTimeout: 'انتهت مهلة البث — لم تُستقبَل بيانات صوتية',
    potUnreachable: (url) => `yt-dlp فشل — PoT Provider غير متاح على ${url}`,
    soundEffect: 'تعذّر تشغيل الملف الصوتي',
    soundConnect: 'تعذّر الاتصال لتشغيل المؤثر الصوتي',
    noVideos: 'لا يوجد فيديوهات على هذه القناة.',
    noChannel: 'تعذّر العثور على قائمة فيديوهات هذه القناة.',
    playFailed: (attempts) => `تعذر التشغيل بعد ${attempts} محاولات.`,
};
// ---------------------------------------------------------------------------
// إشعارات Webhook
// ---------------------------------------------------------------------------
export const NOTIFY = {
    newCycle: (cycleNum, total) => `اكتملت الدورة #${cycleNum} — تم تشغيل كل الـ${total} مقطع.`,
    stopped: (guildName, attempts) => `${guildName} — تعذر التشغيل بعد ${attempts} محاولات.`,
    potDown: (url) => `تعذر الاتصال بـ \`${url}\``,
    authFails: (count) => `فشل yt-dlp ${count} مرات متتالية — تحقق من الكوكيز`,
    rejoinFailed: (guildId, attempt, msg) => `Guild \`${guildId}\` فشل في الإعادة ${attempt} مرات.\n\`${msg.slice(0, 300)}\``,
};
// ---------------------------------------------------------------------------
// ردود أوامر البوت (Slash Commands)
// ---------------------------------------------------------------------------
export const CMD = {
    // /تخطي
    skip: {
        notPlaying: '❌ لا يوجد مقطع يعمل حالياً.',
        notEnoughPoints: (cost, balance) => `❌ نقاطك غير كافية. التخطي يكلف **${cost}** نقطة وعندك **${balance}** نقطة.`,
        skipped: (title, cost) => `⏭️ تم التخطي عن **${title}**\n🪙 خُصم **${cost}** نقطة من رصيدك.`,
    },
    // /افضل_مقطع
    priority: {
        invalidId: '❌ معرّف الفيديو غير صحيح (يجب أن يكون 11 حرفاً).',
        notEnoughPoints: (cost, balance) => `❌ نقاطك غير كافية. الأولوية تكلف **${cost}** نقطة وعندك **${balance}** نقطة.`,
        added: (title, cost) => `✅ تمت إضافة **${title}** كأول مقطع قادم.\n🪙 خُصم **${cost}** نقطة من رصيدك.`,
        fetchError: '❌ تعذّر جلب تفاصيل الفيديو.',
    },
    // /نقاطي
    points: {
        noData: '📊 لم تُسجَّل لك إحصائيات بعد.',
        title: '🪙 رصيد نقاطك',
    },
    // /بث
    live: {
        invalidUrl: '❌ الرابط غير صحيح. أدخل رابط يوتيوب صالحاً.',
        starting: '📡 جارٍ بدء البث المباشر...',
        notLive: '❌ الرابط لا يبدو بثاً مباشراً. استخدم /عشوائي للتشغيل العادي.',
        started: (title) => `📡 بث مباشر: **${title}**`,
        error: '❌ تعذّر بدء البث المباشر.',
    },
    // /وقف_البث
    stopLive: {
        notLive: '❌ لا يوجد بث مباشر نشط الآن.',
        stopped: '✅ تم إيقاف البث المباشر والعودة للراديو العشوائي.',
    },
    // عام
    general: {
        unexpectedError: (msg) => `❌ حدث خطأ غير متوقع: ${msg}`,
        notInVoice: '❌ يجب أن تكون في روم صوتي.',
        botNotInVoice: '❌ البوت ليس في روم صوتي.',
    },
};
// ---------------------------------------------------------------------------
// رسائل شخصية البوت (للـ embeds — تُختار عشوائياً)
// ---------------------------------------------------------------------------
export const PERSONALITY_LINES = [
    'الآن معكم على الهوا 🎙️',
    'البث مباشر ahora 📡',
    'نشتغل بشدة 💪',
    'waheed Radio live 🔴',
    'الحياة والكمبيوتر continues 🖥️',
];
/**
 * يرجع سطر شخصية عشوائي.
 * @returns {string}
 */
export function randomPersonalityLine() {
    return PERSONALITY_LINES[Math.floor(Math.random() * PERSONALITY_LINES.length)];
}
