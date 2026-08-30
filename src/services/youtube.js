/**
 * YouTube Data API v3 integration.
 * Fetches videos from the channel's "uploads" playlist for random/latest
 * playback, plus per-video details (duration, thumbnail) for the
 * "Now Playing" embed.
 *
 * Quota note: `playlistItems.list` and `videos.list` cost **1 unit** per
 * call, versus 100 units for `search.list`. On the free 10,000/day quota
 * that's the difference between ~100 requests and ~5,000+ per day, so
 * everything here goes through the uploads playlist instead of search.
 */

import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { notify } from '../utils/webhook.js';

const logger = createLogger('youtube');

/** True once we've already sent a quota-exhaustion webhook today, so a 24/7
 *  bot hammering a dead quota doesn't spam the channel every retry. */
let quotaAlertSentAt = 0;
const QUOTA_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

function isQuotaError(err) {
  return /\b403\b/.test(err.message) && /quota/i.test(err.message);
}

async function alertQuotaExhausted(err) {
  const now = Date.now();
  if (now - quotaAlertSentAt < QUOTA_ALERT_COOLDOWN_MS) return;
  quotaAlertSentAt = now;
  await notify(
    '🟡 YouTube API Quota Exhausted',
    'The YouTube Data API quota has been used up for the day (resets ~midnight Pacific). '
    + 'Falling back to the last cached video list so playback keeps running — new uploads '
    + "won't show up until the quota resets.\n"
    + `\`\`\`${err.message.slice(0, 400)}\`\`\``,
    'warn',
  );
}

const LIST_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — the video catalog rarely changes
const DETAILS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — duration/thumbnail never change
const MAX_PAGES = 10; // up to 500 videos; plenty for a channel archive, keeps quota bounded

let uploadsPlaylistCache = { id: null, channelId: null };
let listCache = { items: null, fetchedAt: 0 };
const detailsCache = new Map(); // videoId -> { data, fetchedAt }

async function callApi(endpoint, params) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API error ${res.status} on ${endpoint}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Resolve (and cache) the channel's "uploads" playlist ID. */
async function getUploadsPlaylistId(channelId, apiKey) {
  if (uploadsPlaylistCache.id && uploadsPlaylistCache.channelId === channelId) {
    return uploadsPlaylistCache.id;
  }

  const params = new URLSearchParams({
    part: 'contentDetails',
    id: channelId,
    key: apiKey,
  });
  const data = await callApi('channels', params);
  const uploadsId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('تعذّر العثور على قائمة فيديوهات هذه القناة.');

  uploadsPlaylistCache = { id: uploadsId, channelId };
  return uploadsId;
}

function mapPlaylistItem(item) {
  const thumb = item.snippet.thumbnails?.maxres
    || item.snippet.thumbnails?.high
    || item.snippet.thumbnails?.medium
    || item.snippet.thumbnails?.default
    || null;

  return {
    title: item.snippet.title,
    videoId: item.contentDetails?.videoId || item.snippet.resourceId?.videoId,
    url: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId || item.snippet.resourceId?.videoId}`,
    thumbnail: thumb?.url || null,
    publishedAt: item.contentDetails?.videoPublishedAt || item.snippet.publishedAt,
  };
}

/**
 * Fetch (and cache) the channel's video catalog via the uploads playlist,
 * newest first, paginated up to MAX_PAGES.
 * @returns {Promise<Array<{title, videoId, url, thumbnail, publishedAt}>>}
 */
export async function getVideos(
  channelId = config.channelId,
  apiKey = config.youtubeApiKey,
  { useCache = true } = {},
) {
  const now = Date.now();
  if (useCache && listCache.items && now - listCache.fetchedAt < LIST_CACHE_TTL_MS) {
    return listCache.items;
  }

  try {
    const uploadsPlaylistId = await getUploadsPlaylistId(channelId, apiKey);

    const videos = [];
    let pageToken;
    let pages = 0;

    do {
      const params = new URLSearchParams({
        part: 'contentDetails,snippet',
        playlistId: uploadsPlaylistId,
        maxResults: '50',
        key: apiKey,
      });
      if (pageToken) params.set('pageToken', pageToken);

      const data = await callApi('playlistItems', params);
      for (const item of data.items || []) {
        const mapped = mapPlaylistItem(item);
        if (mapped.videoId) videos.push(mapped);
      }
      pageToken = data.nextPageToken;
      pages += 1;
    } while (pageToken && pages < MAX_PAGES);

    if (videos.length === 0) throw new Error('لا يوجد فيديوهات على هذه القناة.');

    listCache = { items: videos, fetchedAt: now };
    logger.info(`Fetched ${videos.length} videos from channel uploads (${pages} page(s)).`);
    return videos;
  } catch (err) {
    // Quota exhaustion is common on a 24/7 continuous-playback bot. Rather
    // than letting the whole radio go silent until midnight Pacific, keep
    // serving the last known-good list (however stale) so playback continues
    // with the videos we already know about.
    if (isQuotaError(err) && listCache.items) {
      logger.warn('YouTube quota exhausted — serving stale cached video list.');
      alertQuotaExhausted(err).catch(() => {});
      return listCache.items;
    }
    if (isQuotaError(err)) {
      alertQuotaExhausted(err).catch(() => {});
    }
    throw err;
  }
}

/**
 * Fetch the latest video from the configured channel.
 * @returns {Promise<{title, videoId, url, thumbnail}>}
 */
export async function getLatestVideo(channelId = config.channelId, apiKey = config.youtubeApiKey) {
  const videos = await getVideos(channelId, apiKey);
  // The uploads playlist is already newest-first.
  return videos[0];
}

/**
 * Pick a random video, optionally avoiding a set of recently-played video IDs
 * so continuous playback doesn't repeat the same handful of clips back to back.
 * @param {string[]} exclude - video IDs to avoid if possible
 */
export async function getRandomVideo(channelId = config.channelId, apiKey = config.youtubeApiKey, exclude = []) {
  const videos = await getVideos(channelId, apiKey);
  const pool = videos.filter((v) => !exclude.includes(v.videoId));
  const list = pool.length > 0 ? pool : videos; // fall back if everything was excluded
  return list[Math.floor(Math.random() * list.length)];
}

/** Parse an ISO-8601 duration (e.g. "PT1H2M3S") into whole seconds. */
function parseIsoDuration(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!match) return null;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

/**
 * Fetch (and cache) duration + thumbnail for a single video, used to build
 * the "Now Playing" embed. Cheap (1 quota unit) and cached for an hour
 * since this data never changes for an existing video.
 * @returns {Promise<{durationSeconds: number|null, thumbnail: string|null} | null>}
 */
export async function getVideoDetails(videoId, apiKey = config.youtubeApiKey) {
  const now = Date.now();
  const cached = detailsCache.get(videoId);
  if (cached && now - cached.fetchedAt < DETAILS_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const params = new URLSearchParams({
      part: 'contentDetails,snippet,statistics',
      id: videoId,
      key: apiKey,
    });
    const data = await callApi('videos', params);
    const item = data.items?.[0];
    if (!item) return null;

    const thumb = item.snippet?.thumbnails?.maxres
      || item.snippet?.thumbnails?.high
      || item.snippet?.thumbnails?.medium
      || null;

    const details = {
      durationSeconds: parseIsoDuration(item.contentDetails?.duration),
      thumbnail: thumb?.url || null,
      viewCount: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
      publishedAt: item.snippet?.publishedAt || null,
    };
    detailsCache.set(videoId, { data: details, fetchedAt: now });
    return details;
  } catch (err) {
    logger.warn(`Failed to fetch video details for ${videoId}:`, err.message);
    return null;
  }
}
