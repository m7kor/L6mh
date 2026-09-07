module.exports = {
  apps: [{
    name: 'yt-audio-bot',
    script: 'src/index.js',
    cwd: '/home/ubuntu/discord-yt-audio-bot',
    env: {
      PATH: '/usr/local/bin:/home/ubuntu/.deno/bin:' + (process.env.PATH || ''),
      NODE_ENV: 'production',
    },
    max_memory_restart: '300M',
    exp_backoff_restart_delay: 100,
  }],
};
