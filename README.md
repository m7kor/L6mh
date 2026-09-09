<div align="center">
  <h1>🎙️ WaheedTech Radio Bot</h1>
  <p><strong>بوت ديسكورد إذاعة مستمرة 24/7 — لوحة تحكم ويب + صفحة عامة + نظام مجتمع</strong></p>
  <p>
    <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node.js">
    <img src="https://img.shields.io/badge/discord.js-v14-blue" alt="Discord.js">
    <img src="https://img.shields.io/badge/yt--dlp-latest-red" alt="yt-dlp">
    <img src="https://img.shields.io/badge/license-MIT-gray" alt="MIT">
  </p>
</div>

---

## ✨ الميزات

### 📻 راديو مستمر
- **بث 24/7** من فيديوهات قناة وحيد عمر مع خوارزمية shuffle-bag (بدون تكرار حتى انتهاء الدورة)
- **تنقل ذكي** بين القنوات الصوتية تلقائياً حسب عدد المستمعين
- **مؤثرات صوتية** ترحيبية عند الدخول (اختياري)

### 🌐 لوحة تحكم ويب (`/`)
- **تصميم عصري** بالdark mode مع الهوية البصرية (Cyan + Orange + Purple)
- **Now Playing** مع شريط تقدم مباشر
- **إحصائيات حية**: مدة التشغيل، عدد المقاطع، الدورة الحالية
- **قائمة مقاطع** مع بحث/فلترة/تشغيل + فلتر "لم تُشغَّل بعد"
- **سجل أخطاء** + **حالة النظام** (yt-dlp، PoT Provider، الكوكيز، قاعدة البيانات)
- **دخول دائم** — التوكن ينحفظ بـ localStorage
- **Kiosk Mode** (`/admin/kiosk`) — نسخة مبسّطة للعرض على شاشة

### 📺 صفحة عامة (`/live`)
- **بدون تسجيل دخول** — ت_accessible للجميع
- Now Playing + إحصائيات + آخر ما شُغّل
- **لوحة الشرف** — Top 10 أكثر الأعضاء استماعاً

### 🏅 نظام المجتمع
- **تتبّع الحضور** — يحسب ساعات الاستماع تلقائياً عبر VoiceStateUpdate
- **أوسمة**: 🎧 مستمع دائم، 🔥 لا يفوّت شي، ⭐ نجم الروم، 🌙 سهران
- **اختياري (Opt-out)** — الأعضاء يقدرون يخفيون أسماءهم من اللوحة العامة

### 🛡️ استقرار
- **Race condition free** — حالة التشغيل محفوظة بـ SQLite (لا ملفات JSON مشتركة)
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
- حساب ديسكورد (Bot Token)

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
├── commands/                # أوامر البوت
│   ├── random.js            # /عشوائي
│   ├── resume.js            # /كمل
│   ├── next.js              # /قريب
│   ├── test.js              # /اختبر
│   ├── stats.js             # /احصائياتي
│   ├── leaderboard.js       # /المتصدرين
│   ├── hide-stats.js        # /اخفاء_احصائياتي
│   └── show-stats.js        # /اظهار_احصائياتي
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
    ├── migration.js         # ترحيل JSON → SQLite
    ├── webhook.js           # إشعارات Webhook
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

## 📝 ملاحظات معروفة

- **لوحة الشرف** بالصفحة العامة تعرض بيانات أول سيرفر متصل فقط. لو المشروع توسّع لأكثر من سيرفر، يحتاج تحديث.
- **Kiosk Mode** بسيط — للعرض فقط بدون تفاعل.

---

<div align="center">
  <p><i>Developed with ❤️ for WaheedTech Studio</i></p>
</div>
