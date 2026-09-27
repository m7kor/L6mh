import { createLogger } from '../utils/logger.js';
import { getAllSessions } from './player/index.js';
import { playVideo } from './player/engine.js';
import { getVideos } from './youtube.js';
import { notify } from '../utils/webhook.js';

const logger = createLogger('scheduler');

// Example hardcoded schedule, could be moved to DB or config
const SCHEDULE = [
  {
    hour: 8,
    minute: 0,
    tag: 'morning',
    name: 'فترة الصباح',
    // Could define a specific video ID or let it filter by tag
  },
  {
    hour: 20,
    minute: 0,
    tag: 'evening',
    name: 'فترة المساء',
  }
];

/** Ticks are 60s and a trigger can take longer than that; never overlap them. */
let ticking = false;
let interval = null;

export function stopScheduler() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export function startScheduler(client) {
  logger.info('Scheduler started.');
  stopScheduler();

  interval = setInterval(async () => {
    // A trigger awaits a per-guild `playVideo`, which can spend up to 60s
    // establishing a voice connection. Without this guard a second tick fires
    // for the same minute and starts a second track over the first.
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      for (const event of SCHEDULE) {
        if (currentHour === event.hour && currentMinute === event.minute) {
          logger.info(`Triggering scheduled event: ${event.name}`);
          await triggerScheduledEvent(client, event);
        }
      }
    } catch (err) {
      logger.error('Scheduler tick failed:', err);
    } finally {
      ticking = false;
    }
  }, 60000); // Check every minute
}

async function triggerScheduledEvent(client, event) {
  try {
    const all = getAllSessions();
    const catalog = await getVideos();

    // Find videos matching the event tag or just a random video if no tags
    const possibleVideos = catalog;
    // If you had tags in your video details, you could filter here:
    // possibleVideos = catalog.filter(v => v.tags?.includes(event.tag));

    if (possibleVideos.length === 0) return;

    const randomVideo = possibleVideos[Math.floor(Math.random() * possibleVideos.length)];

    let done = 0;
    for (const session of all) {
      // A session the operator stopped stays stopped. `playVideo` sets
      // `continuous = true`, so without this check the 20:00 event restarted
      // every manually stopped radio, once a day, forever.
      if (!session.connected || session.paused || !session.continuous) continue;

      const guild = client.guilds.cache.get(session.guildId);
      const botChannel = guild?.members.me?.voice?.channel;

      if (guild && botChannel) {
        logger.info(`[${guild.id}] Playing scheduled event: ${event.name} -> ${randomVideo.title}`);
        await playVideo(guild, botChannel, randomVideo);
        done++;
      }
    }

    if (done > 0) {
      notify('⏰ حدث مجدول', `تم بدء **${event.name}** في ${done} سيرفر.`, 'info').catch(() => {});
    }
  } catch (err) {
    logger.error(`Error triggering scheduled event ${event.name}:`, err);
  }
}
