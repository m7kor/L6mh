/**
 * pm2 process config for running the bot 24/7 with automatic restarts.
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'yt-audio-bot',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,          // restart automatically if the process exits
      max_restarts: 50,           // give up only after many rapid failures
      min_uptime: '30s',          // a restart under 30s doesn't count as "stable"
      restart_delay: 5000,        // wait 5s between restarts
      max_memory_restart: '400M', // restart if memory usage grows unexpectedly
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
