# Sounds folder

Drop short audio clips here (`.mp3`, `.ogg`, `.wav`, `.m4a`, or `.flac`).
These are used as **jingles** — automatically played between tracks and
when the bot joins/moves to a voice channel.

The bot picks a random clip using least-recently-played weighting, so
the same sound doesn't repeat back-to-back.

## Configuration

Enable/disable sound effects in `.env`:

```
SOUND_EFFECTS_ENABLED=true
SOUND_EFFECTS_MIN_MINUTES=8    # minimum interval between jingles
SOUND_EFFECTS_MAX_MINUTES=20   # maximum interval between jingles
```

## Behavior

- A jingle plays between tracks (masked by the track transition gap)
- The current stream is **not** paused — the jingle plays as a separate
  audio layer and the main playback resumes seamlessly after
- Sound effects are internal only; there is no user-facing `/sound` command
