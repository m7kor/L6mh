import { spawn } from 'node:child_process';

const cf = spawn('C:\\Project\\discord-yt-streamer\\cloudflared.exe', ['tunnel', '--url', 'http://localhost:3334'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

cf.stdout.on('data', (d) => process.stdout.write(d));
cf.stderr.on('data', (d) => process.stderr.write(d));
cf.on('exit', (code) => process.exit(code ?? 1));
