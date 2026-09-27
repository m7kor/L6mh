/** Read-only dashboard state inference. No Discord client or engine side effects. */
export type PlaybackState = 'playing' | 'paused' | 'buffering' | 'disconnected' | 'stopped' | 'idle';

export interface PlaybackSnapshot {
  current?: unknown;
  manualStop?: boolean;
  continuous?: boolean;
  advancing?: boolean;
  interjecting?: boolean;
  player?: { state?: { status?: string } } | null;
  connection?: {
    state?: { status?: string; subscription?: { player?: unknown } };
  } | null;
}

export function inferPlaybackState(session: PlaybackSnapshot): PlaybackState {
  // A retained/restored current track is not evidence of audible playback.
  if (session.manualStop) return 'stopped';
  if (!session.current) return 'idle';
  if (!session.player && !session.continuous) return 'stopped';

  const voiceStatus = session.connection?.state?.status;
  if (!session.connection || voiceStatus === 'destroyed' || voiceStatus === 'disconnected') {
    return 'disconnected';
  }
  if (voiceStatus !== 'ready') return 'buffering';

  // During an interjection the connection can be subscribed to another player.
  const subscribedPlayer = session.connection.state?.subscription?.player;
  if (session.interjecting || (subscribedPlayer && subscribedPlayer !== session.player)) {
    return 'buffering';
  }

  switch (session.player?.state?.status) {
    case 'playing': return 'playing';
    case 'paused':
    case 'autopaused': return 'paused';
    case 'buffering': return 'buffering';
    default: return session.advancing || (!session.player && session.continuous) ? 'buffering' : 'idle';
  }
}

/** The subset of a session summary the public page needs. */
export interface PublicSessionLike {
  playbackState?: string;
  title?: string | null;
  [key: string]: unknown;
}

/** Keep retained metadata available, but prefer genuinely active sessions. */
export function selectPublicSession<T extends PublicSessionLike>(sessions: readonly T[]): T | null {
  return sessions.find(s => s.playbackState === 'playing')
    || sessions.find(s => s.playbackState === 'paused')
    || sessions.find(s => s.playbackState === 'buffering')
    || sessions.find(s => s.title)
    || sessions[0]
    || null;
}
