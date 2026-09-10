<div align="center">
  <h1>🎙️ راديو وحيد عمر<br>WaheedTech Radio Bot</h1>
  <p><strong>بوت ديسكورد إذاعة مستمرة 24/7 — لوحة تحكم ويب + صفحة عامة + نظام مجتمع</strong></p>
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
- **Now Playing** مع شريط تقدم مباشر
- **إحصائيات حية**: مدة التشغيل، عدد المقاطع
- **قائمة مقاطع** مع بحث/فلترة/تشغيل + فلتر "لم تُشغَّل بعد"
- **سجل أخطاء** + **حالة النظام** (yt-dlp، PoT Provider، الكوكيز، قاعدة البيانات)
- **دخول دائم** — التوكن ينحفظ تلقائياً
- **Kiosk Mode** (`/admin/kiosk`) — نسخة مبسّطة للعرض على شاشة

### 📺 صفحة عامة (`/live`)
- **بدون تسجيل دخول** — متاحة للجميع
- Now Playing + إحصائيات + آخر ما شُغّل
- **لوحة الشرف** — Top 10 أكثر الأعضاء استماعاً

### 🏅 نظام المجتمع
- **تتبّع الحضور** — يحسب ساعات الاستماع تلقائياً
- **أوسمة**: 🎧 مستمع دائم، 🔥 لا يفوّت شي، ⭐ نجم الروم، 🌙 سهران
- **اختياري (Opt-out)** — إخفاء الاسم من اللوحة العامة مع الحفاظ على البيانات

### 🛡️ استقرار
- **Race condition free** — SQLite بدل JSON
- **Stall Detection** — يكتشف الت停滞 ويتخطاه تلقائياً
- **Graceful Shutdown** — حفظ الحالة عند الإيقاف

---

## 🚀 الأوامر

| الأمر | الوظيفة |
|-------|---------|
| `/عشوائي` | تشغيل عشوائي مستمر |
| `/اخر_مقطع` | آخر مقطع بالقناة |
| `/كمل` | استكمال التشغيل |
| `/قريب` | الفيديوهات القادمة بالقائمة |
| `/اختبر` | فحص yt-dlp + PoT Provider |
| `/احصائياتي` | إحصائياتك + أوسمتك |
| `/المتصدرين` | لوحة Top 10 الشهرية |
| `/اخفاء_احصائياتي` | إخفاء اسمك من اللوحة العامة |
| `/اظهار_احصائياتي` | إظهار اسمك مرة ثانية |

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
أنشئ ملف `.env`:
```env
DISCORD_TOKEN=توكن البوت
YOUTUBE_API_KEY=مفتاح YouTube API
CHANNEL_ID=معرّف القناة
DASHBOARD_TOKEN=كلمة سر الداشبورد
STATUS_PORT=3333
POT_PROVIDER_URL=http://127.0.0.1:4416
COOKIE_BROWSER=none
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
├── index.js                 # نقطة الدخول الرئيسية
├── config.js                # قراءة متغيرات البيئة
├── commands/                # أوامر البوت (9 أوامر)
├── services/
│   ├── player.js            # محرك التشغيل الرئيسي
│   ├── streaming.js         # yt-dlp + FFmpeg
│   ├── session.js           # إدارة الجلسات (SQLite)
│   ├── youtube.js           # YouTube API
│   ├── cookies.js           # إدارة الكوكيز
│   └── community.js         # نظام المجتمع والأوسمة
└── utils/
    ├── database.js          # SQLite (better-sqlite3)
    ├── stats.js             # إحصائيات التشغيل
    ├── status-page.js       # Dashboard + API
    ├── embeds.js            # رسائل ديسكورد
    └── tests.test.js        # 60 اختبار
```

---

## 🧪 الاختبارات

```bash
npm test
```

- 60 اختبار يغطي: formatTime, cookies, videoId, cooldown, queue, database, stats, session state
- يستخدم **in-memory SQLite** — لا يلمس قاعدة الإنتاج

---

<div align="center">
  <p><i>Developed with ❤️ for WaheedTech Studio</i></p>
</div>
