#!/bin/bash
# Oracle Cloud Free Tier deployment script for discord-yt-audio-bot
# Run this on a fresh Ubuntu 22.04/24.04 LTS instance
set -e

echo "=== Discord YT Audio Bot — Oracle Cloud Setup ==="

# Track whether .env already existed (to decide auto-start later)
ENV_EXISTED=false

# 1. System updates
echo "[1/12] Updating system..."
sudo apt update && sudo apt upgrade -y

# 2. Swapfile (Oracle Free Tier E2.1.micro has 1GB RAM — need swap for Node+ffmpeg+yt-dlp)
echo "[2/12] Setting up swapfile..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo "2GB swapfile created and activated."
else
  echo "Swapfile already exists."
fi

# 3. Firewall (STATUS_PORT rule added later after .env is created)
echo "[3/12] Configuring firewall..."
if ! command -v ufw &> /dev/null; then
  sudo apt install -y ufw
fi
sudo ufw allow OpenSSH
sudo ufw --force enable
sudo ufw status verbose

# 4. Install Node.js 20.x
echo "[4/12] Installing Node.js..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "Node: $(node -v) | npm: $(npm -v)"

# 5. Install ffmpeg
echo "[5/12] Installing ffmpeg..."
if ! command -v ffmpeg &> /dev/null; then
  sudo apt install -y ffmpeg
fi
echo "ffmpeg: $(ffmpeg -version 2>&1 | head -1)"

# 6. Install yt-dlp
echo "[6/12] Installing yt-dlp..."
if ! command -v yt-dlp &> /dev/null; then
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
fi
echo "yt-dlp: $(yt-dlp --version)"

# 7. Install pm2
echo "[7/12] Installing pm2..."
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
  sudo pm2 startup systemd -u $USER --hp $HOME
fi

# 8. Install PoT provider (Docker — brainicism/bgutil-ytdlp-pot-provider)
echo "[8/12] Installing PoT provider (Docker)..."
if ! command -v docker &> /dev/null; then
  sudo apt install -y docker.io
  sudo systemctl enable --now docker
fi
if ! sudo docker ps -a --format '{{.Names}}' | grep -q '^bgutil-provider$'; then
  sudo docker run --name bgutil-provider -d --init --restart unless-stopped \
    -p 127.0.0.1:4416:4416 \
    brainicism/bgutil-ytdlp-pot-provider
  echo "PoT provider container started on 127.0.0.1:4416"
else
  sudo docker start bgutil-provider
  echo "PoT provider container already exists, started."
fi

# Verify PoT provider is listening
sleep 3
if curl -s http://127.0.0.1:4416 > /dev/null 2>&1; then
  echo "PoT provider confirmed listening on 127.0.0.1:4416"
else
  echo "WARNING: PoT provider may not be running. Check: sudo docker logs bgutil-provider"
fi

# 9. Clone and setup bot
echo "[9/12] Setting up bot..."
cd /home/$USER
if [ ! -d "discord-yt-audio-bot" ]; then
  git clone https://github.com/m7kor/L6mh.git discord-yt-audio-bot
fi
cd discord-yt-audio-bot
npm install

# 10. Create .env if missing
echo "[10/12] Configuring .env..."
if [ -f .env ]; then
  ENV_EXISTED=true
else
  cp .env.example .env
fi

# 11. Open dashboard port in firewall if STATUS_PORT is set in .env
STATUS_PORT_VAL=$(grep -E '^STATUS_PORT=' .env 2>/dev/null | cut -d '=' -f2)
if [ -n "$STATUS_PORT_VAL" ]; then
  sudo ufw allow "$STATUS_PORT_VAL/tcp" 2>/dev/null || true
  echo "Firewall: opened port $STATUS_PORT_VAL for dashboard."
else
  echo "Note: STATUS_PORT not set in .env — dashboard port not opened."
  echo "To enable dashboard later: sudo ufw allow <PORT>/tcp"
fi

# 12. cookies.txt permissions
echo "[11/12] Checking cookies.txt..."
if [ -f cookies.txt ]; then
  chmod 600 cookies.txt
  echo "cookies.txt permissions set to 600."
else
  echo "cookies.txt not found — place it manually and run: chmod 600 cookies.txt"
fi

# 13. Start bot (only if .env already existed — fresh installs need manual .env edit first)
echo "[12/12] Starting bot..."
if [ "$ENV_EXISTED" = true ]; then
  pm2 start src/index.js --name yt-audio-bot
  pm2 save
  echo "Bot started."
else
  echo ""
  echo "=== FIRST RUN — EDIT .env BEFORE STARTING ==="
  echo "nano /home/$USER/discord-yt-audio-bot/.env"
  echo ""
  echo "After editing .env, run:"
  echo "  pm2 start src/index.js --name yt-audio-bot"
  echo "  pm2 save"
fi

echo ""
echo "=== SETUP COMPLETE ==="
echo ""
if [ "$ENV_EXISTED" = false ]; then
  echo "1. Edit .env:  nano /home/$USER/discord-yt-audio-bot/.env"
  echo "2. Place cookies.txt:  nano /home/$USER/discord-yt-audio-bot/cookies.txt"
  echo "3. Set cookie perms:   chmod 600 /home/$USER/discord-yt-audio-bot/cookies.txt"
  echo "4. Start bot:          pm2 start src/index.js --name yt-audio-bot"
  echo "5. Deploy commands:    npm run deploy"
  echo "6. Save pm2:           pm2 save"
else
  echo "1. Place cookies.txt:  nano /home/$USER/discord-yt-audio-bot/cookies.txt"
  echo "2. Set cookie perms:   chmod 600 /home/$USER/discord-yt-audio-bot/cookies.txt"
  echo "3. Deploy commands:    npm run deploy"
  echo "4. Restart bot:        pm2 restart yt-audio-bot"
fi
echo ""
echo "Useful commands:"
echo "  pm2 logs yt-audio-bot              — view logs"
echo "  pm2 restart yt-audio-bot           — restart"
echo "  pm2 status                         — check status"
echo "  sudo docker logs bgutil-provider   — PoT provider logs"
echo "  sudo docker restart bgutil-provider — restart PoT provider"
echo "  sudo ufw status                    — firewall rules"
echo "  swapon --show                      — verify swap"
