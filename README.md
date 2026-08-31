# Discord YouTube Audio Bot

Discord bot that plays **[وحيد عمر's YouTube channel](https://www.youtube.com/@Waheedomar)** audio in voice channels 24/7. Three simple commands.

## Commands

| Command | Description |
|---|---|
| `/شيوائي` | Pick a random video and play it forever |
| `/اخر_مقطع` | Play the latest video and continue forever |
| `/كمل` | Resume the last video that was playing |

## How It Works

```
YouTube video
    ↓  yt-dlp (streams audio directly)
    ↓  ffmpeg (transcodes to PCM s16le 48kHz stereo)
    ↓  @discordjs/voice
Plays in voice channel
```

## Project Structure

```
src/
  index.js            entry point — auto-join, slash commands, voice events
  config.js           validates environment variables
  deploy-commands.js  registers slash commands with Discord
  commands/
    random.js         /شيوائي
    watch.js          /اخر_مقطع
    resume.js         /كمل
  services/
    player.js         playback engine — voice connection, yt-dlp→ffmpeg pipeline, jingles
    youtube.js        YouTube Data API v3 with caching
  utils/
    logger.js         timestamped console logger
    sounds.js         discover sound files from /sounds
    embeds.js         "Now Playing" embed
sounds/               mp3 files used as jingles between tracks
```

## Setup

### Prerequisites

- Node.js 18+
- FFmpeg (`winget install Gyan.FFmpeg`)
- yt-dlp (`winget install yt-dlp.yt-dlp`)
- Discord Bot token + YouTube Data API key

### Install

```powershell
git clone https://github.com/m7kor/L6mh.git
cd L6mh
npm install
copy .env.example .env
```

Edit `.env` with your tokens and IDs, then:

```powershell
npm run deploy
npm start
```

### Run 24/7 with pm2

```powershell
npm install -g pm2
pm2 start src/index.js --name yt-audio-bot
pm2 save
```

To auto-start on Windows login, create a shortcut in:
```
C:\Users\<you>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
```
with target: `pm2 resurrect`

| Command | Description |
|---|---|
| `pm2 list` | Show running processes |
| `pm2 logs yt-audio-bot` | Tail logs |
| `pm2 restart yt-audio-bot` | Restart the bot |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Yes | Application ID from Discord Developer Portal |
| `YOUTUBE_API_KEY` | Yes | YouTube Data API v3 key |
| `CHANNEL_ID` | Yes | YouTube channel ID to pull videos from |
| `VOICE_CHANNEL_ID` | No | Voice channel to auto-join on startup |
| `HEALTH_WEBHOOK_URL` | No | Discord webhook for crash/quota notifications |
| `GUILD_ID` | No | Server ID for instant command updates (testing) |
| `DEFAULT_VOLUME` | No | Default volume 0-200 (default: 100) |

## Features

- **Auto-join**: joins voice channel on startup if `VOICE_CHANNEL_ID` is set; also joins when someone is alone in a channel
- **Jingles**: random sound files from `/sounds/` play between tracks
- **Progress saving**: saves playback position every 15 seconds; `/كمل` resumes from where it left off
- **Broken URL handling**: skips videos with expired CDN URLs automatically
- **24/7 playback**: never stops — when a video ends, picks the next one
