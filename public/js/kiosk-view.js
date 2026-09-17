/** Kiosk display logic. Truthful lamp: animation only for genuine playback. */
export function createKioskView(document) {
  const LABELS = {
    playing: 'على الهواء', paused: 'متوقف مؤقتاً', buffering: 'جاري تجهيز الصوت',
    disconnected: 'انقطع اتصال الصوت', stopped: 'متوقف', idle: 'لا يوجد بث حالياً',
    unknown: 'حالة غير مؤكدة', loading: 'جاري الاتصال…',
  };

  return {
    /** Apply a /api/public payload; returns the state that was applied. */
    apply(d) {
      const np = d && d.nowPlaying;
      const state = np ? (np.playbackState || (np.paused ? 'paused' : 'unknown'))
                       : (d ? 'idle' : 'loading');
      const dot = document.getElementById('liveDot');
      const wave = document.getElementById('kioskWave');
      if (document.body && document.body.dataset) document.body.dataset.state = state;
      if (dot) dot.className = 'kiosk-live-dot' + (state === 'playing' ? '' : ' off');
      const text = document.getElementById('liveText');
      if (text) text.textContent = LABELS[state] || LABELS.unknown;
      const title = document.getElementById('nowTitle');
      if (title) title.textContent = np ? (np.title || '—') : (state === 'idle' ? 'لا يوجد بث حالياً' : title.textContent);
      if (wave) {
        if (wave.classList) wave.classList.toggle('off', state !== 'playing');
        else wave.className = 'kiosk-wave' + (state === 'playing' ? '' : ' off');
      }
      if (d) {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('statPlays', d.totalPlays || 0);
        set('statUptime', d.uptimeHours || 0);
        set('statVideos', d.totalVideos || 0);
      }
      return state;
    },
    markUnknown(lastUpdated) {
      const state = this.apply(null);
      const text = document.getElementById('liveText');
      if (text) text.textContent = 'الحالة غير مؤكدة' + (lastUpdated ? ' · آخر تحديث ' + lastUpdated.toLocaleTimeString('ar') : '');
      return state;
    },
    LABELS,
  };
}

export async function checkKioskJingles(document, fetchFn, state) {
  try {
    const r = await fetchFn(`/api/activity/state?since=${state.since}`);
    if (!r.ok) return;
    const d = await r.json();
    for (const j of d.jingles || []) {
      const flash = document.getElementById('kioskFlash');
      if (flash) {
        flash.className = 'active ' + j.category;
        setTimeout(() => { flash.className = ''; }, 400);
      }
      state.since = Math.max(state.since, j.at || 0);
    }
    if (d.timestamp) state.since = Math.max(state.since, d.timestamp);
  } catch {}
}
