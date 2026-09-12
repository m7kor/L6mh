/**
 * player/index.js — نقطة الدخول الموحدة لخدمة المشغل.
 *
 * يُعيد تصدير جميع الدوال العامة من الوحدات المتخصصة:
 *   - engine.js   : playRandom, playLatest, playVideo, resume, connectAndPlay
 *   - controls.js : stop, skip, volume, pause, resume, getters
 *   - ui-updater.js : attachNowPlayingMessage
 *   - jingles.js  : playSoundEffect (للاستخدام من index.js)
 *
 * باقي الكود الذي كان يستورد من 'services/player.js'
 * لا يحتاج لأي تغيير — فقط يستورد من 'services/player/index.js'.
 */
// من engine.js
export { playRandom, playLatest, playVideo, resume, connectAndPlay } from './engine.js';
// من controls.js
export { playerEvents, stopPlayback, stopAllSessions, skipTrack, setVolume, pausePlayback, resumePlayback, getQueue, getSessionInfo, getAllSessions, } from './controls.js';
// من ui-updater.js
export { attachNowPlayingMessage, triggerUiUpdate, clearNowPlayingMessage } from './ui-updater.js';
// من jingles.js
export { playRandomJingle, playSoundEffect } from './jingles.js';
