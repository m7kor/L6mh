/**
 * YouTube Data API v3 integration.
 * Fetches videos from a channel for random/sequential playback.
 */

/**
 * Fetch the latest video from a YouTube channel.
 * @param {string} channelId
 * @param {string} apiKey
 * @returns {Promise<{ title: string, videoId: string, url: string }>}
 */
export async function getLatestVideo(channelId, apiKey) {
  const params = new URLSearchParams({
    part: 'snippet',
    channelId,
    order: 'date',
    type: 'video',
    maxResults: '1',
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  if (!data.items || data.items.length === 0) {
    throw new Error('No videos found for this channel.');
  }

  const item = data.items[0];
  return {
    title: item.snippet.title,
    videoId: item.id.videoId,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
  };
}

/**
 * Fetch multiple recent videos from a channel (up to 50).
 * Returns an array of { title, videoId, url }.
 *
 * @param {string} channelId
 * @param {string} apiKey
 * @param {number} [maxResults=50]
 * @returns {Promise<Array<{ title: string, videoId: string, url: string }>>}
 */
export async function getVideos(channelId, apiKey, maxResults = 50) {
  const params = new URLSearchParams({
    part: 'snippet',
    channelId,
    order: 'date',
    type: 'video',
    maxResults: String(Math.min(maxResults, 50)),
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  if (!data.items || data.items.length === 0) {
    throw new Error('No videos found for this channel.');
  }

  return data.items.map((item) => ({
    title: item.snippet.title,
    videoId: item.id.videoId,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
  }));
}

/**
 * Get a random video from the channel.
 * Fetches up to 50 recent videos and picks one at random.
 *
 * @param {string} channelId
 * @param {string} apiKey
 * @returns {Promise<{ title: string, videoId: string, url: string }>}
 */
export async function getRandomVideo(channelId, apiKey) {
  const videos = await getVideos(channelId, apiKey, 50);
  const idx = Math.floor(Math.random() * videos.length);
  return videos[idx];
}
