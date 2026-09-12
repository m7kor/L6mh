<div align="center">
  <h1>🎙️ راديو وحيد عمر<br>WaheedTech Radio Bot</h1>
  <p><strong>بوت ديسكورد إذاعة مستمرة 24/7 — لوحة تحكم ويب + صفحة عامة</strong></p>
  <p>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node.js"></a>
    <a href="https://discord.js.org/"><img src="https://img.shields.io/badge/discord.js-v14-blue" alt="Discord.js"></a>
    <a href="https://github.com/yt-dlp/yt-dlp"><img src="https://img.shields.io/badge/yt--dlp-latest-red" alt="yt-dlp"></a>
    <img src="https://img.shields.io/badge/license-MIT-gray" alt="MIT">
  </p>
</div>

---

## ✨ الميزات

### 📻 راديو مستمر
- **بث 24/7** من فيديوهات قناة وحيد عمر
- **خوارزمية shuffle-bag** — تخطي بدون تكرار حتى انتهاء الدورة
- **تنقل ذكي** بين القنوات الصوتية حسب عدد المستمعين
- **مؤثرات صوتية** ترحيبية عند الدخول (اختياري)

### 🌐 لوحة تحكم ويب (`/`)
- **تصميم عصري** بالdark mode
- **Now Playing** مع شريط تقدم مباشر + أزرار تحكم
- **إحصائيات حية**: مدة التشغيل، عدد المقاطع
- **قائمة مقاطع** مع بحث/فلترة/تشغيل + فلتر "لم تُشغَّل بعد"
- **سجل أخطاء** + **حالة النظام** (yt-dlp، PoT Provider، الكوكيز، قاعدة البيانات)
- **دخول دائم** — التوكن ينحفظ تلقائياً
- **Kiosk Mode** (`/admin/kiosk`) — نسخة مبسّطة للعرض على شاشة

### 📺 صفحة عامة (`/live`)
- **بدون تسجيل دخول** — متاحة للجميع
- Now Playing + إحصائيات + آخر ما شُغّل
- **لوحة الشرف** — Top 100 أكثر الأعضاء استماعاً

### 🛡️ استقرار
- **Race condition free** — SQLite بدل JSON
- **Stall Detection** — يكتشف التوقف ويتخطاه تلقائياً
- **Graceful Shutdown** — حفظ الحالة عند الإيقاف
- **بدون حدود** — أوامر بدون cooldown، API بدون rate limit

---

## 🚀 الأوامر

| الأمر | الوظيفة |
|-------|---------|
| `/عشوائي` | تشغيل عشوائي مستمر |
| `/اخر_مقطع` | آخر مقطع بالقناة |
| `/كمل` | استكمال التشغيل |
| `/قائمة` | عرض مقاطع التشغيل القادمة |

---

## 🛠️ التقنيات

| التقنية | الاستخدام |
|---------|-----------|
| Node.js 18+ | Runtime |
| discord.js v14 | بوت ديسكورد |
| yt-dlp | سحب صوت يوتيوب |
| FFmpeg | معالجة صوتيات |
| SQLite (better-sqlite3) | قاعدة البيانات |
| PM2 | إدارة التشغيل 24/7 |

---

## ⚙️ التثبيت والتشغيل

### المتطلبات
- Node.js 18+
- yt-dlp
- FFmpeg

### 1. التثبيت
```bash
git clone https://github.com/m7kor/L6mh.git
cd L6mh
npm install
```

### 2. إعداد المتغيرات
أنشئ ملف `.env` من `.env.example`:
```bash
cp .env.example .env
```

ثم عدّل القيم المطلوبة:
```env
DISCORD_TOKEN=توكن البوت
CLIENT_ID=معرّف التطبيق (Application ID)
YOUTUBE_API_KEY=مفتاح YouTube API
CHANNEL_ID=معرّف القناة
DASHBOARD_TOKEN=كلمة سر الداشبورد
STATUS_PORT=3333
```

### 3. التشغيل
```bash
# تطوير
npm run dev

# إنتاج (PM2)
pm2 start ecosystem.config.cjs
pm2 save

# الاختبارات
npm test
```

### 4. أوامر مفيدة
```bash
pm2 restart yt-audio-bot    # إعادة تشغيل
pm2 logs yt-audio-bot       # متابعة السجلات
pm2 status                  # حالة البوت
```

---

## 📁 هيكل المشروع

```
src/
├── index.js                    # نقطة الدخول الرئيسية
├── config.js                   # قراءة متغيرات البيئة
├── lang.js                     # النصوص المركزي
├── deploy-commands.js          # تسجيل أوامر ديسكورد
├── commands/                   # أوامر البوت (4 أوامر)
│   ├── random.js               # /عشوائي
│   ├── latest.js               # /اخر_مقطع
│   ├── resume.js               # /كمل
│   ├── queue.js                # /قائمة
│   └── play-command.js         # helper مشترك
├── services/
│   ├── player/                 # محرك التشغيل
│   │   ├── index.js            # barrel exports
│   │   ├── engine.js           # محرك الصوت الأساسي
│   │   ├── controls.js         # التحكم بالتشغيل
│   │   ├── jingles.js          # المؤثرات الصوتية
│   │   └── ui-updater.js       # تحديث رسائل ديسكورد
│   ├── streaming.js            # yt-dlp + FFmpeg
│   ├── session.js              # إدارة الجلسات (SQLite)
│   ├── youtube.js              # YouTube API
│   ├── cookies.js              # إدارة الكوكيز
│   ├── community.js            # الحضور واللوحة
│   └── scheduler.js            # جدولة التشغيل
└── utils/
    ├── database.js             # SQLite (better-sqlite3)
    ├── stats.js                # إحصائيات التشغيل
    ├── status-page.js          # Dashboard + API
    ├── embeds.js               # رسائل ديسكورد
    ├── logger.js               # تسجيل مركزي
    ├── format.js               # تنسيق الأوقات
    ├── cooldown.js             # إدارة Cooldown
    ├── permissions.js          # صلاحيات DJ
    ├── sounds.js               # الملفات الصوتية
    ├── heartbeat.js            # ملف النبض
    ├── migration.js            # JSON → SQLite
    ├── webhook.js              # إشعارات Webhook
    ├── weekly-recap.js         # ملخص أسبوعي
    ├── ytdlp-update.js         # تحديث yt-dlp
    └── tests.test.js           # 72 اختبار
```

---

## 🧪 الاختبارات

```bash
npm test
```

- **72 اختبار** يغطي: formatTime, cookies, videoId, cooldown, queue, database, stats, session state, embeds, lang.js
- يستخدم **in-memory SQLite** — لا يلمس قاعدة الإنتاج

---

<div align="center">
  <p><i>Developed with ❤️ for WaheedTech Studio</i></p>
</div>
