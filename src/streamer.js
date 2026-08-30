/**
 * Audio streaming logic with continuous playback.
 *
 * - Plays YouTube audio via yt-dlp → ffmpeg → @discordjs/voice
 * - Auto-plays next random video when current finishes
 * - Saves playback state to resume later
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';
import { getRandomVideo, getLatestVideo } from './youtube.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let connection = null;
let player = null;
let ytdlpProcess = null;
let ffmpegProcess = null;

/** @type {'random' | 'latest' | 'resume' | null} */
let playbackMode = null;

/** @type {boolean} — should auto-play next video when current finishes */
let continuous = false;

/** @type {string | null} — channel ID for random playback */
let channelId = null;

/** @type {string | null} — YouTube API key */
let youtubeApiKey = null;

/** @type {{ title: string, url: string } | null} — last played video (for resume) */
let lastVideo = null;

// State file path
const STATE_FILE = join(process.cwd(), 'playback-state.json');

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function saveState() {
  try {
    const state = {
      lastVideo,
      channelId,
      playbackMode,
      continuous,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('[audio] State saved.');
  } catch (err) {
    console.error('[audio] Failed to save state:', err.message);
  }
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      lastVideo = data.lastVideo || null;
      channelId = data.channelId || channelId;
      playbackMode = data.playbackMode || null;
      continuous = data.continuous || false;
      console.log('[audio] State loaded.');
      return data;
    }
  } catch (err) {
    console.error('[audio] Failed to load state:', err.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stop any active playback and disconnect from voice.
 */
export function stopPlayback() {
  continuous = false;
  if (player) {
    player.stop(true);
    player = null;
  }
  if (connection) {
    try { connection.destroy(); } catch {}
    connection = null;
  }
  killProcesses();
  saveState();
  console.log('[audio] Stopped playback and disconnected.');
}

/**
 * Configure the bot for continuous playback.
 * Call this once at startup to set channel ID and API key.
 */
export function configure(apiKey, chanId) {
  youtubeApiKey = apiKey;
  channelId = chanId;
  loadState();
}

/**
 * Get the last played video info (for /كمل).
 */
export function getLastVideo() {
  return lastVideo;
}

/**
 * Get current playback mode.
 */
export function getPlaybackMode() {
  return playbackMode;
}

/**
 * Join a voice channel and play the latest video (single play).
 */
export async function playLatest(guild, channel) {
  await stopPlayback();

  const { title, url } = await getLatestVideo(channelId, youtubeApiKey);
  lastVideo = { title, url };
  playbackMode = 'latest';
  continuous = false;

  await connectAndPlay(guild, channel, url, title);
}

/**
 * Join a voice channel and play a random video (continuous loop).
 */
export async function playRandom(guild, channel) {
  await stopPlayback();

  playbackMode = 'random';
  continuous = true;

  const video = await getRandomVideo(channelId, youtubeApiKey);
  lastVideo = { title: video.title, url: video.url };

  await connectAndPlay(guild, channel, video.url, video.title);
}

/**
 * Resume the last played video (single play).
 */
export async function resume(guild, channel) {
  await stopPlayback();

  if (!lastVideo) {
    throw new Error('No previous video to resume. Use /watch latest or /watch first.');
  }

  playbackMode = 'resume';
  continuous = false;

  await connectAndPlay(guild, channel, lastVideo.url, lastVideo.title);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function connectAndPlay(guild, channel, url, title) {
  console.log(`[audio] Playing: ${title}`);

  // Join voice
  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    console.log('[audio] Voice disconnected');
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
    console.log(`[audio] Connected to #${channel.name}`);
  } catch (err) {
    try { connection.destroy(); } catch {}
    connection = null;
    throw new Error(`Failed to connect to voice: ${err.message}`);
  }

  // Create audio stream
  const audioStream = await createAudioStream(url);

  const resource = createAudioResource(audioStream, {
    inputType: StreamType.OggOpus,
    inlineVolume: false,
  });

  player = createAudioPlayer();

  player.on(AudioPlayerStatus.Idle, () => {
    console.log('[audio] Video finished.');
    onVideoFinished(guild, channel);
  });

  player.on('error', (err) => {
    console.error('[audio] Player error:', err);
  });

  connection.subscribe(player);
  player.play(resource);

  saveState();
  console.log('[audio] Now playing in voice channel.');
}

/**
 * Called when a video finishes. If continuous mode, play next random video.
 */
async function onVideoFinished(guild, channel) {
  if (!continuous) {
    console.log('[audio] Continuous mode off. Stopping.');
    stopPlayback();
    return;
  }

  console.log('[audio] Playing next random video…');
  try {
    const video = await getRandomVideo(channelId, youtubeApiKey);
    lastVideo = { title: video.title, url: video.url };
    await connectAndPlay(guild, channel, video.url, video.title);
  } catch (err) {
    console.error('[audio] Error playing next video:', err);
    stopPlayback();
  }
}

function killProcesses() {
  if (ytdlpProcess) {
    try { ytdlpProcess.kill(); } catch {}
    ytdlpProcess = null;
  }
  if (ffmpegProcess) {
    try { ffmpegProcess.kill(); } catch {}
    ffmpegProcess = null;
  }
}

function createAudioStream(youtubeUrl) {
  return new Promise((resolve, reject) => {
    // First get the direct URL via yt-dlp --get-url
    ytdlpProcess = spawn('yt-dlp', [
      '--get-url',
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      youtubeUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let directUrl = '';

    ytdlpProcess.stdout.on('data', (chunk) => {
      directUrl += chunk.toString();
    });

    ytdlpProcess.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log(`[yt-dlp] ${msg}`);
    });

    ytdlpProcess.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    ytdlpProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited with code ${code}`));
      }

      const url = directUrl.trim().split('\n')[0];
      if (!url) {
        return reject(new Error('yt-dlp returned no URL'));
      }

      console.log('[audio] Got direct URL, streaming with ffmpeg…');

      // ffmpeg streams directly from the URL (no full download)
      ffmpegProcess = spawn('ffmpeg', [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url,
        '-f', 'ogg',
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-application', 'lowdelay',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let ffmpegErr = '';
      ffmpegProcess.stderr.on('data', (chunk) => {
        ffmpegErr += chunk.toString();
      });

      ffmpegProcess.on('error', (err) => {
        reject(new Error(`Failed to start ffmpeg: ${err.message}`));
      });

      ffmpegProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[ffmpeg] exit code ${code}`);
          console.error(`[ffmpeg] stderr: ${ffmpegErr.slice(-500)}`);
        }
      });

      resolve(ffmpegProcess.stdout);
    });
  });
}
