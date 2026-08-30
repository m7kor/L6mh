# Discord YouTube Audio Bot

A Discord bot dedicated to **[وحيد عمر's YouTube channel](https://www.youtube.com/@Waheedomar)**
— plays its videos in voice channels 24/7, with a live "Now Playing" card,
button controls, an ambient soundboard, skip, and volume control. Locked to
this one channel (via `CHANNEL_ID`) with no way to play arbitrary URLs, and
runs on your own Windows PC.

## How It Works

```
YouTube video
    ↓  yt-dlp (resolves to direct audio URL)
Direct audio URL
    ↓  ffmpeg (transcodes to Opus/OGG)
Opus audio stream
    ↓  @discordjs/voice
Plays in voice channel
```

## Project Structure

```
src/
  index.js            entry point — loads commands, wires up the Discord client
  config.js           validates and exposes environment variables
  deploy-commands.js  registers slash commands with Discord (run after adding a command)
  commands/           one file per slash command (data + execute)
  services/
    player.js          playback engine: voice connection, queue, yt-dlp/ffmpeg pipeline
    youtube.js          YouTube Data API v3 calls, with short caching
  utils/
    logger.js           small timestamped/scoped console logger
```

Playback state (per guild) is a plain JSON file, `playback-state.json`, so `/كمل`
can resume the last video after a restart.

Video lookups go through the channel's **uploads playlist**
(`playlistItems.list`) rather than YouTube's search endpoint — 1 quota unit
per call instead of 100, so the free 10,000/day quota comfortably supports
24/7 continuous playback plus normal command use.

## Commands

| Command | Description |
|---|---|
| `/watch` | Play the channel's **latest** video, then continue forever (24/7) — default |
| `/watch mode:random` | Same, but start with a random pick instead of the latest |
| `/nowplaying` | Show a live "Now Playing" card with a progress bar and button controls |
| `/skip` | Skip the current track (the next one auto-plays — it never just stops) |
| `/queue` | Show what's currently playing, volume, and the upcoming queue |
| `/volume percent:<0-200>` | Set playback volume |
| `/sound name:<name>` | Manually trigger a local sound effect from `/sounds` (autocompletes as you type) |
| `/status` | Diagnostics: connection state, uptime, memory, yt-dlp/ffmpeg versions |
| `/كمل` | Resume the last video that was played |
| `/favorite` | Save the video that's currently playing to your personal favorites |
| `/favorites` | List your saved favorites, or remove one with `remove:<title>` |
| `/top` | Leaderboard of the most-played videos on this bot |

Now Playing cards also show the video's view count and upload date when available.

Every "Now Playing" card also has ⏸/▶️ skip, volume, and stop buttons — no
need to type a command for basic control once one is on screen. The bot's
Discord status also shows "Watching `<title>`" while something's playing.

**By design there's no `/stop` command and no `/watch url:<link>` option** —
this bot only ever plays وحيد عمر's channel, and it's meant to run
continuously. Every play command keeps going forever once a video ends, it
just moves on to another one. If you genuinely need to stop it (e.g. before
restarting your PC), use the ⏹️ button on the Now Playing card, or stop the
pm2 process directly (`pm2 stop yt-audio-bot`).

### Auto-join

Two ways the bot joins voice on its own, no command needed:
- **On startup**, if `VOICE_CHANNEL_ID` is set in `.env`, it joins that channel and starts the 24/7 radio.
- **Anytime**, if someone joins a voice channel that's empty (they're alone), the bot hops in and starts the radio automatically — and leaves again once everyone's gone.

### Health notifications (optional)

Set `HEALTH_WEBHOOK_URL` in `.env` to a Discord webhook URL (Channel
Settings → Integrations → Webhooks → New Webhook, ideally in a private
channel only you can see) and the bot posts short status embeds for:

- Startup (bot logged in)
- Uncaught exceptions right before it restarts
- Login failures
- Voice rejoin trouble that's gone on for 5+ attempts in a row
- YouTube API quota exhaustion (and when it silently starts serving a
  cached video list to keep the radio running)

This is entirely optional — leave it blank and the bot behaves exactly the
same, it just won't page you when something's wrong. Meant to save you from
having to `pm2 logs` to notice the PC's internet dropped overnight.

### Automatic yt-dlp self-update

YouTube changes things often enough that yt-dlp can go stale and suddenly
fail to resolve audio (`no audio plays` in Troubleshooting below is usually
this). On every startup the bot runs `yt-dlp -U` in the background — if an
update is available it installs itself; if not, nothing happens. This is
best-effort and never blocks startup or fails it; if your yt-dlp install
doesn't support self-update (e.g. installed via `pip` instead of the
standalone binary), it just logs that and moves on.

### Ambient soundboard

Drop short clips (`.mp3`, `.ogg`, `.wav`, `.m4a`, `.flac`) into the `sounds/`
folder and the bot automatically drops in a random one every so often while
the radio is playing — **no command needed**. By default it picks a random
clip every 8–20 minutes; tune this with `SOUND_EFFECTS_MIN_MINUTES` /
`SOUND_EFFECTS_MAX_MINUTES` in `.env`, or set `SOUND_EFFECTS_ENABLED=false`
to turn it off entirely. You can still trigger one manually anytime with
`/sound name:<filename>`. Either way, the main video pauses, the clip
plays once, then the video resumes exactly where it left off.

---

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name → **Create**
3. Go to **Bot** tab → click **Reset Token** → copy the token (this is your `DISCORD_TOKEN`)
4. Under **Privileged Gateway Intents**, enable:
   - Message Content Intent
5. Go to **General Information** → copy the **Application ID** (this is your `CLIENT_ID`)

### 2. Invite the Bot to Your Server

1. Go to **OAuth2 → URL Generator**
2. Under **Scopes**, check:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, check:
   - Connect
   - Speak
   - Use Voice Activity
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

### 3. Get a YouTube Data API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services > Library**
4. Search for **YouTube Data API v3** and click **Enable**
5. Go to **APIs & Services > Credentials**
6. Click **Create Credentials > API Key**
7. Copy the generated API key

### 4. Find Your Channel ID

The `CHANNEL_ID` is the YouTube channel ID for the channel you want to pull videos from.

1. Go to the channel page (e.g. `https://www.youtube.com/@Waheedomar`)
2. View page source (`Ctrl+U`)
3. Search for `channelId` — you'll find something like `"channelId":"UC..."`
4. The value starting with `UC` is the channel ID

### 5. Windows Setup

#### Install Node.js (LTS)

1. Download from [nodejs.org](https://nodejs.org/) (v18+)
2. Run installer, accept defaults
3. Verify: `node --version`

#### Install FFmpeg

```powershell
winget install Gyan.FFmpeg
```

Close and reopen terminal, then verify: `ffmpeg -version`

#### Install yt-dlp

```powershell
winget install yt-dlp.yt-dlp
```

Close and reopen terminal, then verify: `yt-dlp --version`

### 6. Configure and Run

```powershell
cd C:\Project\discord-yt-streamer
copy .env.example .env
```

Edit `.env` and fill in your values:

```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
YOUTUBE_API_KEY=your_api_key
CHANNEL_ID=UC...your_channel_id

# optional tuning
DEFAULT_VOLUME=100
QUEUE_PREVIEW_SIZE=5
```

Install dependencies and register commands:

```powershell
npm install
npm run deploy
```

Start the bot:

```powershell
npm start
```

You should see something like:
```
[bot] 2026-08-27 20:15:00 Logged in as YourBot#1234
[bot] 2026-08-27 20:15:00 Channel ID: UC...
[bot] 2026-08-27 20:15:00 Commands loaded: /nowplaying, /queue, /كمل, /skip, /status, /stop, /volume, /watch
```

Join a voice channel in Discord and type `/watch latest` — the bot will join and play the audio.

### 7. Running 24/7 with pm2

The bot itself now recovers from most transient problems on its own:
voice connections re-signal automatically after a network blip, and if
that fails it retries rejoining the channel every ~10-60s (backing off);
fetching the next random video also retries with backoff instead of
going silent; and any error while a track is playing just skips to the
next one instead of stopping. **But the Node process itself still needs
a supervisor** in case of a genuine crash (OS update, PC hiccup, an
unrecoverable Discord API error) — that's what pm2 is for.

An `ecosystem.config.cjs` is included with sensible restart settings.

```powershell
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

To make pm2 itself survive a PC reboot on Windows:

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

| Command | Description |
|---|---|
| `pm2 list` | Show running processes |
| `pm2 logs yt-audio-bot` | Tail logs |
| `pm2 restart yt-audio-bot` | Restart the bot |
| `pm2 monit` | Live CPU/memory dashboard |

**For a true 24/7 setup, also:**
- In Windows **Power & sleep settings**, set "Sleep" to **Never** (a sleeping
  PC pauses the bot entirely — pm2 can't fix that).
- Keep the PC's internet connection stable; Wi-Fi power-saving on the
  adapter can silently drop long-lived connections — disable it in
  Device Manager → network adapter → Properties → Power Management.
- If your YouTube Data API key hits its daily quota, the bot falls back to
  the last cached video list so playback keeps running (just without picking
  up new uploads) until the quota resets (usually midnight Pacific time). If
  `HEALTH_WEBHOOK_URL` is set you'll get a notification when this happens.

### 8. Adding a New Command

1. Create a new file in `src/commands/`, exporting `data` (a `SlashCommandBuilder`)
   and an async `execute(interaction)` function — see any existing file as a template.
2. Run `npm run deploy` to register it with Discord.
3. Restart the bot (`npm start`, or `pm2 restart yt-audio-bot`).

### 9. Notes

- The PC must stay on and connected to the internet
- Each Discord server (guild) the bot is in gets its own independent playback session
- If the bot is already playing in a server, `/watch` stops the current stream there first
- If the caller isn't in a voice channel, the bot replies with an ephemeral error
- The video list from YouTube is cached for 30 minutes; per-video details (duration/thumbnail) are cached for 1 hour
- Continuous (`/watch`) mode avoids replaying the last 20 videos where possible
- yt-dlp and ffmpeg errors are logged to the console
- Favorites are stored in `favorites.json`, play counts (for `/top`) in
  `play-counts.json` — both plain JSON files, safe to back up or delete to reset
- To update the bot: `git pull && npm install && pm2 restart yt-audio-bot`

## Troubleshooting

| Problem | Solution |
|---|---|
| `ffmpeg not found` | Install FFmpeg and restart terminal |
| `yt-dlp not found` | Install yt-dlp and restart terminal |
| `Login failed` | Check your DISCORD_TOKEN is correct |
| Bot doesn't appear in server | Re-invite with correct permissions |
| Commands don't show up / show old names | Run `npm run deploy` again. Global commands can take up to ~1hr to propagate — set `GUILD_ID` in `.env` for instant updates while testing, and try restarting Discord (it sometimes caches old command info) |
| No audio plays | Check the console for yt-dlp/ffmpeg errors |
| Volume/queue seem "stuck" per server | Each guild has its own session now — check you're testing in the right server |
