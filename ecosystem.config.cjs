module.exports = {
  apps: [{
    name: 'yt-audio-bot',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'production',
    },
    max_memory_restart: '300M',
    exp_backoff_restart_delay: 100,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true,
    max_size: '10M',
    retain: 7,
  }],
};
