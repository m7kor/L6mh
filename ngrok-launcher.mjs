import { spawn } from 'node:child_process';

const ng = spawn('C:\\Project\\discord-yt-streamer\\ngrok.exe', ['http', '3334'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

ng.stdout.on('data', (d) => process.stdout.write(d));
ng.stderr.on('data', (d) => process.stderr.write(d));
ng.on('exit', (code) => process.exit(code ?? 1));
