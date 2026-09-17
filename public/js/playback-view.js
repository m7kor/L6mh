/** Render actual transport state; retained track metadata is not proof of playback. */
export function renderPlaybackState(document, session) {
  const state = session?.playbackState || (session?.paused ? 'paused' : 'unknown');
  const labels = {
    playing: 'على الهواء', paused: 'متوقف مؤقتاً', buffering: 'جاري تجهيز الصوت',
    disconnected: 'انقطع اتصال الصوت', stopped: 'متوقف', idle: 'لا يوجد بث حالياً',
    unknown: 'حالة التشغيل غير مؤكدة',
  };
  const playing = state === 'playing';
  document.getElementById('npTag').textContent = labels[state] || labels.unknown;
  document.querySelectorAll('.np-vis span').forEach(bar => bar.classList.toggle('off', !playing));
  const elapsed = state === 'stopped' || state === 'idle' ? 0 : Math.max(0, Number(session?.elapsedSeconds) || 0);
  const duration = Math.max(0, Number(session?.durationSeconds) || 0);
  document.getElementById('npFill').style.width = duration ? `${Math.min(100, elapsed / duration * 100)}%` : '0%';
  if (state === 'stopped' || state === 'idle') document.getElementById('npElapsed').textContent = '0:00';
  return playing;
}
