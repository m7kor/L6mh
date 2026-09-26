// @ts-nocheck
/**
 * crossfade.ts — true equal-power crossfade between tracks.
 *
 * عند نهاية مقطع، بدلاً من قطعه قاطع، يمزج بين صوت المقطع الحالي
 * وصوت المقطع التالي خلال فترة انتقالية (افتراضياً 4 ثوانٍ).
 *
 * الخوارزمية: منحنيات cos/sin (equal-power) تحافظ على مستوى الصوت
 * خلال الانتقال — لا توجد نقطة هدوء في المنتصف كما في fade خطي.
 *
 * تدفق البيانات:
 *   current PCM (s16le 48kHz stereo) ─┐
 *                                      ├──> CrossfadeReadable ──> AudioResource
 *   next PCM    (s16le 48kHz stereo) ─┘
 *
 * التوافق: Windows + Linux. لا يعتمد على named pipes أو FIFOs.
 */

import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// ثوابت التنسيق — s16le 48kHz stereo
// ---------------------------------------------------------------------------

const SAMPLE_FRAME_SIZE = 4;       // L16 (2 بايت) + R16 (2 بايت) = 4 بايت لكل إطار
const BYTES_PER_SECOND  = 48000 * SAMPLE_FRAME_SIZE; // 192,000 بايت/ثانية

// ---------------------------------------------------------------------------
// منحنيات العامل — equal-power crossfade
// ---------------------------------------------------------------------------

/** عامل تناقص المقطع الحالي: cos(0)=1 → cos(π/2)=0 */
function gainOut(t, dur) {
  if (t <= 0) return 1.0;
  if (t >= dur) return 0.0;
  return Math.cos((t / dur) * (Math.PI / 2));
}

/** عامل زيادة المقطع التالي: sin(0)=0 → sin(π/2)=1 */
function gainIn(t, dur) {
  if (t <= 0) return 0.0;
  if (t >= dur) return 1.0;
  return Math.sin((t / dur) * (Math.PI / 2));
}

// ---------------------------------------------------------------------------
// خلاط عينة واحدة (L/R pair)
// ---------------------------------------------------------------------------

function mixOne(aL, aR, bL, bR, gA, gB) {
  const cL = Math.round(aL * gA + bL * gB);
  const cR = Math.round(aR * gA + bR * gB);
  return [
    Math.max(-32768, Math.min(32767, cL)),
    Math.max(-32768, Math.min(32767, cR)),
  ];
}

// ---------------------------------------------------------------------------
// CrossfadeReadable — extends Readable، يدمج مصدرين PCM
// ---------------------------------------------------------------------------

/**
 * دفق Readable يدمج مصدرين PCM (s16le 48kHz stereo) بمدة انتقال محددة.
 *
 * الحالات:
 *   START     → يخرج من currentStream فقط (قبل بدء المزج)
 *   CROSSFADE → يخرج المخلوط من الاثنين
 *   END_CUR   → currentStream انتهى أثناء المزج — يكمل مع next فقط
 *   END_NEXT  → nextStream انتهى أثناء المزج — نادر، نكمل مع current فقط
 *   DONE      → انتهى كلاهما
 *
 * الطريقة: يستخدم on('data') من كلا المصدرين لجمع الدفعات،
 *       ويخرجها عبر this.push() عندما يحتاج الـ consumer بيانات.
 *       لا يعتمد على async/await معقد — كل شيء في سياق event loop.
 */
export class CrossfadeReadable extends Readable {
  constructor(
    currentStream,
    nextStream,
    durationSec = 4.0,
    onHalfway = null,
    onComplete = null,
  ) {
    super({ read() {} });
    this.cur    = currentStream;
    this.next   = nextStream;
    this.dur    = durationSec;
    this.durBytes = Math.floor(durationSec * BYTES_PER_SECOND);
    this.onHalf = onHalfway || null;
    this.onDone = onComplete || null;

    this.state = 'START';
    this.outBytes = 0;
    this.halfwayFired = false;

    // pending chunks من كل مصدر
    this.pendingCur = null;
    this.pendingNext = null;

    // علامات الانتهاء
    this.curEnded = false;
    this.nextEnded = false;

    // أخطاء
    this.curError = null;
    this.nextError = null;

    // ربط مستمعي الأخطاء والانتهاء
    if (this.cur) {
      this.cur.on('error', (e) => { this.curError = e; });
      this.cur.on('end', () => {
        this.curEnded = true;
        this._onSourceEnd('cur');
      });
    }
    if (this.next) {
      this.next.on('error', (e) => { this.nextError = e; });
      this.next.on('end', () => {
        this.nextEnded = true;
        this._onSourceEnd('next');
      });
    }

    // جمع الدفعات القادمة
    this._onCurData = (chunk) => {
      this.pendingCur = chunk;
      this._drain();
    };
    this._onNextData = (chunk) => {
      this.pendingNext = chunk;
      this._drain();
    };

    if (this.cur)    this.cur.on('data', this._onCurData);
    if (this.next)   this.next.on('data', this._onNextData);

    // ابدأ소화 بيانات متاحة فورًا
    this._drain();
  }

  /**
   * محرك التصريف الحدثي: يُستدعى عند وصول بيانات أو انتهاء مصدر.
   * يعتمد على loop داخلي عشان يستمر في المعالجة حتى اكتمال الدولة.
   * لا يسبب infinite loop لأن كل تكرار إما بيخرج بيانات أو بيتغير حالة.
   */
  _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      let progressed = false;
      do {
        progressed = false;

        if (this.curError)  { this.destroy(this.curError);  return; }
        if (this.nextError) { this.destroy(this.nextError); return; }

        // ---------------------------------------------------------------------------
        // الحالة START: نخرج من current فقط حتى يبدأ المزج
        // ---------------------------------------------------------------------------
        if (this.state === 'START') {
          const chunk = this._takeChunk('cur');
          if (chunk) {
            const safe = this._frameSafe(chunk);
            if (safe.length > 0) {
              this.outBytes += safe.length;
              this.push(safe);
            }
            progressed = true;
            if (this.outBytes >= this.durBytes) {
              this.state = 'CROSSFADE';
            }
            if (this.curEnded) {
              this.state = 'END_CUR';
            }
          } else if (this.curEnded) {
            this.state = 'END_CUR';
          }
        }

        // ---------------------------------------------------------------------------
        // الحالة CROSSFADE: نخلط بين current و next
        // ---------------------------------------------------------------------------
        else if (this.state === 'CROSSFADE') {
          const cA = this._takeChunk('cur');
          const cB = this._takeChunk('next');

          if (!cA && !cB) {
            if (this.curEnded && this.nextEnded) {
              this.state = 'DONE';
              this._finish();
              return;
            }
          } else if (!cA && cB) {
            this.state = 'END_CUR';
            const safe = this._frameSafe(cB);
            if (safe.length > 0) { this.push(safe); progressed = true; }
            if (this.nextEnded) { this.state = 'DONE'; this._finish(); return; }
          } else if (cA && !cB) {
            this.state = 'END_NEXT';
            const safe = this._frameSafe(cA);
            if (safe.length > 0) { this.push(safe); progressed = true; }
            if (this.curEnded) { this.state = 'DONE'; this._finish(); return; }
          } else {
            // خلط دفعتين
            const len = Math.min(cA.length, cB.length);
            const safeLen = this._frameAlign(len);
            if (safeLen > 0) {
              const out = Buffer.alloc(safeLen);
              for (let i = 0; i < safeLen; i += SAMPLE_FRAME_SIZE) {
                const aL = cA.readInt16LE(i);
                const aR = cA.readInt16LE(i + 2);
                const bL = cB.readInt16LE(i);
                const bR = cB.readInt16LE(i + 2);

                const t  = (this.outBytes + i) / BYTES_PER_SECOND;
                const gA = gainOut(t, this.dur);
                const gB = gainIn(t, this.dur);
                const [cL, cR] = mixOne(aL, aR, bL, bR, gA, gB);

                out.writeInt16LE(cL, i);
                out.writeInt16LE(cR, i + 2);
              }

              this.outBytes += safeLen;
              this.push(out);
              progressed = true;

              if (!this.halfwayFired && this.outBytes >= this.durBytes / 2) {
                this.halfwayFired = true;
                if (this.onHalf) this.onHalf();
              }

              if (this.outBytes >= this.durBytes) {
                this.state = 'END_CUR';
              }
            }
            if (this.curEnded && this.nextEnded && this.outBytes >= this.durBytes) {
              this.state = 'DONE';
              this._finish();
              return;
            }
          }
        }

        // ---------------------------------------------------------------------------
        // الحالة END_CUR: current انتهى — نخرج من next فقط
        // ---------------------------------------------------------------------------
        else if (this.state === 'END_CUR') {
          const chunk = this._takeChunk('next');
          if (chunk) {
            const safe = this._frameSafe(chunk);
            if (safe.length > 0) { this.push(safe); progressed = true; }
            if (this.nextEnded) { this.state = 'DONE'; this._finish(); return; }
          } else if (this.nextEnded) {
            this.state = 'DONE';
            this._finish();
            return;
          }
        }

        // ---------------------------------------------------------------------------
        // الحالة END_NEXT: next انتهى أثناء المزج — نكمل مع current
        // ---------------------------------------------------------------------------
        else if (this.state === 'END_NEXT') {
          const chunk = this._takeChunk('cur');
          if (chunk) {
            const safe = this._frameSafe(chunk);
            if (safe.length > 0) { this.push(safe); progressed = true; }
            if (this.curEnded) { this.state = 'DONE'; this._finish(); return; }
          } else if (this.curEnded) {
            this.state = 'DONE';
            this._finish();
            return;
          }
        }

        // ---------------------------------------------------------------------------
        // الحالة DONE — لا معالجة 필요
        // ---------------------------------------------------------------------------
      } while (progressed);
    } finally {
      this._draining = false;
    }
  }

  _finish() {
    this.push(null);
    if (this.onDone) this.onDone();
  }

  /**
   * يُستدعى عند انتهاء أحد المصدرين.
   * يتحقق مما إذا كان يمكن إنهاء الخلاط أو المزج.
   */
  _onSourceEnd(which) {
    // إذا لم نكن في مرحلة معالجة نشطة، حاول التصريف مرة أخرى
    this._drain();
  }

  /**
   * يأخذ دفعة من المخزن pending.
   * لا نقرأ من الـ stream مباشرة — ننتظر حدث data.
   * safety net: لو الـ stream خلص قبل ما نسمع end event (مثلاً sync push في test)،
   * نكتشف من readableEnded.
   */
  _takeChunk(which) {
    const key    = which === 'cur' ? 'pendingCur' : 'pendingNext';
    const stream = which === 'cur' ? this.cur : this.next;
    const ended  = which === 'cur' ? this.curEnded : this.nextEnded;

    if (this[key]) {
      const c = this[key];
      this[key] = null;
      return c;
    }

    if (ended || !stream) return null;

    // safety net للـ حالات اللي الـ stream خلص قبل ما ي-fired end event
    if (stream.readableEnded) {
      if (which === 'cur') this.curEnded = true;
      else this.nextEnded = true;
      return null;
    }

    return null;
  }

  /**
   * يقصر الطول على مضاعف حجم إطار العينة.
   */
  _frameSafe(chunk) {
    const aligned = Math.floor(chunk.length / SAMPLE_FRAME_SIZE) * SAMPLE_FRAME_SIZE;
    return aligned > 0 ? chunk.slice(0, aligned) : Buffer.alloc(0);
  }

  /**
   * يعيد الطول المقرب إلى أسفل مضاعف حجم الإطار.
   */
  _frameAlign(len) {
    return Math.floor(len / SAMPLE_FRAME_SIZE) * SAMPLE_FRAME_SIZE;
  }

  /**
   * التنظيف عند التدمير.
   */
  _destroy(err, cb) {
    try {
      if (this.cur)   { this.cur.off?.('data', this._onCurData);    this.cur.off?.('end', this._onCurData); }
      if (this.next)  { this.next.off?.('data', this._onNextData);  this.next.off?.('end', this._onNextData); }
    } catch { /* ignore */ }
    cb(err);
  }

  destroy(err) {
    try { super.destroy(err || undefined); } catch {}
  }
}

// ---------------------------------------------------------------------------
// واجهة برمجية مختصرة
// ---------------------------------------------------------------------------

/**
 * Creates a crossfade Readable that mixes two PCM streams.
 *
 * @param currentStream دفق PCM المقطع الحالي (Readable)
 * @param nextStream    دفق PCM المقطع التالي (Readable)
 * @param durationSec   مدة الانتقال بالثواني (افتراضي: 4.0)
 * @param onHalfway     رد فعل عند منتصف الانتقال
 * @param onComplete    رد فعل عند اكتمال الانتقال (لإيقاف current ffmpeg)
 * @returns Readable جاهز للإرسال إلى AudioResource
 */
export function createCrossfade(
  currentStream,
  nextStream,
  durationSec = 4.0,
  onHalfway = null,
  onComplete = null,
) {
  return new CrossfadeReadable(currentStream, nextStream, durationSec, onHalfway, onComplete);
}

/**
 * هل يمكن تطبيق المزج الآن؟
 */
export function canCrossfade(session) {
  if (!session.player) return false;
  if (!session.current) return false;
  if (!session.current.durationSeconds) return false;
  if (session.current.durationSeconds <= 0) return false;
  if ((session.current.progressSeconds || 0) < 1) return false;
  return true;
}

/**
 * متى نبدأ المزج؟ نبدأ قبل نهاية المقطع الحالي بـ durationSec.
 */
export function crossfadeStartTime(currentDuration, crossfadeDuration) {
  return Math.max(0, currentDuration - crossfadeDuration);
}
