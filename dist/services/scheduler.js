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
export function startScheduler(client) {
    logger.info('Scheduler started.');
    setInterval(async () => {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        for (const event of SCHEDULE) {
            if (currentHour === event.hour && currentMinute === event.minute) {
                logger.info(`Triggering scheduled event: ${event.name}`);
                await triggerScheduledEvent(client, event);
            }
        }
    }, 60000); // Check every minute
}
async function triggerScheduledEvent(client, event) {
    try {
        const all = getAllSessions();
        const catalog = await getVideos();
        // Find videos matching the event tag or just a random video if no tags
        let possibleVideos = catalog;
        // If you had tags in your video details, you could filter here:
        // possibleVideos = catalog.filter(v => v.tags?.includes(event.tag));
        if (possibleVideos.length === 0)
            return;
        const randomVideo = possibleVideos[Math.floor(Math.random() * possibleVideos.length)];
        let done = 0;
        for (const session of all) {
            if (session.connected && !session.paused) {
                const guild = client.guilds.cache.get(session.guildId);
                const botChannel = guild?.members.me?.voice?.channel;
                if (guild && botChannel) {
                    logger.info(`[${guild.id}] Playing scheduled event: ${event.name} -> ${randomVideo.title}`);
                    await playVideo(guild, botChannel, randomVideo);
                    done++;
                }
            }
        }
        if (done > 0) {
            notify('⏰ حدث مجدول', `تم بدء **${event.name}** في ${done} سيرفر.`, 'info').catch(() => { });
        }
    }
    catch (err) {
        logger.error(`Error triggering scheduled event ${event.name}:`, err);
    }
}
