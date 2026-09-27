module.exports = {
  apps: [{
    name: 'yt-audio-bot',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'production',
    },
    // Must sit above the 300MB warning threshold in utils/heartbeat.ts, or a
    // genuine leak is reported as a warning while the supervisor silently
    // restarts the bot instead. `max_restarts` is deliberately high enough that
    // a leak-driven crash loop does not end in a permanently stopped bot —
    // check `processes` in heartbeat.json, which is now reported alongside it.
    max_memory_restart: '1G',
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    exp_backoff_restart_delay: 100,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true,
    max_size: '10M',
    retain: 7,
  }],
};
