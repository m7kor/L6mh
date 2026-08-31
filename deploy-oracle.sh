#!/bin/bash
# Oracle Cloud Free Tier deployment script for discord-yt-audio-bot
# Run this on a fresh Ubuntu 22.04/24.04 LTS instance

set -e

echo "=== Discord YT Audio Bot — Oracle Cloud Setup ==="

# 1. System updates
echo "[1/7] Updating system..."
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js 20.x
echo "[2/7] Installing Node.js..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "Node: $(node -v) | npm: $(npm -v)"

# 3. Install ffmpeg
echo "[3/7] Installing ffmpeg..."
if ! command -v ffmpeg &> /dev/null; then
  sudo apt install -y ffmpeg
fi
echo "ffmpeg: $(ffmpeg -version 2>&1 | head -1)"

# 4. Install yt-dlp
echo "[4/7] Installing yt-dlp..."
if ! command -v yt-dlp &> /dev/null; then
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
fi
echo "yt-dlp: $(yt-dlp --version)"

# 5. Install pm2
echo "[5/7] Installing pm2..."
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
  sudo pm2 startup systemd -u $USER --hp $HOME
fi

# 6. Clone and setup bot
echo "[6/7] Setting up bot..."
cd /home/$USER
if [ ! -d "discord-yt-audio-bot" ]; then
  git clone https://github.com/m7kor/L6mh.git discord-yt-audio-bot
fi
cd discord-yt-audio-bot
npm install

# 7. Create .env if missing
echo "[7/7] Configuring..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "=== EDIT .env WITH YOUR TOKENS ==="
  echo "nano /home/$USER/discord-yt-audio-bot/.env"
  echo ""
fi

echo ""
echo "=== SETUP COMPLETE ==="
echo "1. Edit .env:  nano /home/$USER/discord-yt-audio-bot/.env"
echo "2. Deploy commands:  npm run deploy"
echo "3. Start bot:  pm2 start src/index.js --name yt-audio-bot"
echo "4. Save pm2:  pm2 save"
echo ""
echo "Useful commands:"
echo "  pm2 logs yt-audio-bot    — view logs"
echo "  pm2 restart yt-audio-bot — restart"
echo "  pm2 status               — check status"
