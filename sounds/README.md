# Sounds folder

Drop short audio clips here (`.mp3`, `.ogg`, `.wav`, `.m4a`, or `.flac`) and
they'll automatically show up in Discord's `/sound` command — no restart or
redeploy needed, the bot reads this folder fresh each time.

The file name (without extension) becomes the sound's name in Discord.
For example:

```
sounds/
  airhorn.mp3      → /sound name:airhorn
  applause.ogg      → /sound name:applause
  دخول.mp3          → /sound name:دخول   (Arabic names work fine too)
```

When triggered, the current stream (radio/video) is paused, the sound
effect plays once, and playback resumes exactly where it left off
afterward — nothing gets skipped or restarted.
