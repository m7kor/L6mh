#!/bin/bash
# Oracle Cloud Free Tier deployment script for discord-yt-audio-bot
# Run this on a fresh Ubuntu 22.04/24.04 LTS instance
set -e

echo "=== Discord YT Audio Bot — Oracle Cloud Setup ==="

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

# 3. Firewall
echo "[3/12] Configuring firewall..."
if ! command -v ufw &> /dev/null; then
  sudo apt install -y ufw
fi
sudo ufw allow OpenSSH
# Only open STATUS_PORT if explicitly set (dashboard); PoT provider stays localhost-only
if [ -n "$STATUS_PORT" ]; then
  sudo ufw allow "$STATUS_PORT/tcp"
fi
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

# 8. Install bgutil-ytdlp-pot-provider (PoT provider)
echo "[8/12] Installing PoT provider..."
if ! command -v bgutil-ytdlp-pot-provider &> /dev/null; then
  sudo npm install -g bgutil-ytdlp-pot-provider
fi

# Create systemd unit for PoT provider (runs on 127.0.0.1:4416, localhost-only)
POT_SERVICE_FILE="/etc/systemd/system/pot-provider.service"
if [ ! -f "$POT_SERVICE_FILE" ]; then
  sudo tee "$POT_SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=bgutil-ytdlp-pot-provider
After=network.target

[Service]
Type=simple
ExecStart=$(which bgutil-ytdlp-pot-provider) --port 4416
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable pot-provider
  sudo systemctl start pot-provider
  echo "PoT provider installed and started on 127.0.0.1:4416"
else
  echo "PoT provider service already exists."
  sudo systemctl restart pot-provider
fi

# Verify PoT provider is listening
sleep 2
if curl -s http://127.0.0.1:4416 > /dev/null 2>&1; then
  echo "PoT provider confirmed listening on 127.0.0.1:4416"
else
  echo "WARNING: PoT provider may not be running. Check: sudo systemctl status pot-provider"
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
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "=== EDIT .env WITH YOUR TOKENS ==="
  echo "nano /home/$USER/discord-yt-audio-bot/.env"
  echo ""
fi

# 11. cookies.txt permissions
echo "[11/12] Checking cookies.txt..."
if [ -f cookies.txt ]; then
  chmod 600 cookies.txt
  echo "cookies.txt permissions set to 600."
else
  echo "cookies.txt not found — place it manually and run: chmod 600 cookies.txt"
fi

# 12. Start bot
echo "[12/12] Starting bot..."
pm2 start src/index.js --name yt-audio-bot
pm2 save

echo ""
echo "=== SETUP COMPLETE ==="
echo ""
echo "1. Edit .env:  nano /home/$USER/discord-yt-audio-bot/.env"
echo "2. Place cookies.txt:  nano /home/$USER/discord-yt-audio-bot/cookies.txt"
echo "3. Set cookie perms:   chmod 600 /home/$USER/discord-yt-audio-bot/cookies.txt"
echo "4. Deploy commands:    npm run deploy"
echo "5. Restart bot:        pm2 restart yt-audio-bot"
echo ""
echo "Useful commands:"
echo "  pm2 logs yt-audio-bot           — view logs"
echo "  pm2 restart yt-audio-bot        — restart"
echo "  pm2 status                      — check status"
echo "  sudo systemctl status pot-provider — PoT provider status"
echo "  sudo ufw status                 — firewall rules"
echo "  swapon --show                   — verify swap"
