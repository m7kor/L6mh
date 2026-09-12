#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Discord YT Audio Bot + Activity — Oracle Cloud Free Tier Setup         ║
# ║  One-script deployment: bot + dashboard + Activity video + cloudflared   ║
# ╚═══════════════════════════════════════════════════════════════════════════╝
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_banner() {
  echo ""
  echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  🎙️  راديو وحيد عمر — Oracle Cloud Free Tier Setup          ║${NC}"
  echo -e "${CYAN}║  Bot + Dashboard + Activity Video + Cloudflare Tunnel        ║${NC}"
  echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

print_step() {
  echo ""
  echo -e "${GREEN}━━━ $1 ━━━${NC}"
}

print_warn() {
  echo -e "${YELLOW}⚠  $1${NC}"
}

print_error() {
  echo -e "${RED}❌ $1${NC}"
}

print_ok() {
  echo -e "${GREEN}✅ $1${NC}"
}

print_banner

ENV_EXISTED=false
BOT_DIR="/home/$USER/discord-yt-audio-bot"
ACTIVITY_DIR="$BOT_DIR/activity/server"

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 1: System Setup                                                    ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

print_step "1/10 — System Updates"
sudo apt update && sudo apt upgrade -y

print_step "2/10 — Swapfile (2GB for 1GB RAM instance)"
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  print_ok "2GB swapfile created"
else
  print_ok "Swapfile already exists"
fi

print_step "3/10 — Firewall"
if ! command -v ufw &> /dev/null; then
  sudo apt install -y ufw
fi
sudo ufw allow OpenSSH
sudo ufw --force enable
print_ok "Firewall configured"

print_step "4/10 — Node.js 20.x"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
print_ok "Node $(node -v) | npm $(npm -v)"

print_step "5/10 — ffmpeg"
if ! command -v ffmpeg &> /dev/null; then
  sudo apt install -y ffmpeg
fi
print_ok "ffmpeg installed"

print_step "6/10 — yt-dlp"
if ! command -v yt-dlp &> /dev/null; then
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
fi
print_ok "yt-dlp $(yt-dlp --version)"

print_step "7/10 — PM2"
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
  sudo pm2 startup systemd -u $USER --hp $HOME
fi
print_ok "PM2 installed"

print_step "8/10 — Docker + PoT Provider"
if ! command -v docker &> /dev/null; then
  sudo apt install -y docker.io
  sudo systemctl enable --now docker
fi
if ! sudo docker ps -a --format '{{.Names}}' | grep -q '^bgutil-provider$'; then
  sudo docker run --name bgutil-provider -d --init --restart unless-stopped \
    -p 127.0.0.1:4416:4416 \
    brainicism/bgutil-ytdlp-pot-provider
  print_ok "PoT provider started on 127.0.0.1:4416"
else
  sudo docker start bgutil-provider 2>/dev/null || true
  print_ok "PoT provider already exists"
fi

sleep 3
if curl -s http://127.0.0.1:4416 > /dev/null 2>&1; then
  print_ok "PoT provider responding"
else
  print_warn "PoT provider may not be running — check: sudo docker logs bgutil-provider"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 2: Cloudflare Tunnel (HTTPS for Activity)                          ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

print_step "9/10 — Cloudflare Tunnel (HTTPS — required for Activity)"
if ! command -v cloudflared &> /dev/null; then
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    CF_ARCH="arm64"
  else
    CF_ARCH="amd64"
  fi
  sudo curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /usr/local/bin/cloudflared
  sudo chmod +x /usr/local/bin/cloudflared
  print_ok "cloudflared installed"
else
  print_ok "cloudflared already installed"
fi

# Start quick tunnel (free, no Cloudflare account needed)
# This creates a temporary https://xxxx.trycloudflare.com URL
echo ""
echo -e "${YELLOW}━━━ Cloudflare Tunnel Setup ━━━${NC}"
echo ""
echo "The bot needs HTTPS for the Discord Activity."
echo "We'll use Cloudflare's free quick tunnel (no account needed)."
echo ""

# Kill any existing cloudflared
pkill -f "cloudflared tunnel" 2>/dev/null || true

# Start tunnel in background, capture the URL
ACTIVITY_PORT=$(grep -E '^ACTIVITY_PORT=' "$BOT_DIR/.env" 2>/dev/null | cut -d '=' -f2)
ACTIVITY_PORT=${ACTIVITY_PORT:-3334}

cloudflared tunnel --url http://localhost:${ACTIVITY_PORT} > /tmp/cloudflared.log 2>&1 &
CF_PID=$!
echo "cloudflared PID: $CF_PID"

# Wait for the tunnel URL to appear
echo "Waiting for tunnel URL..."
CF_URL=""
for i in $(seq 1 30); do
  CF_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
  if [ -n "$CF_URL" ]; then
    break
  fi
  sleep 1
done

if [ -n "$CF_URL" ]; then
  print_ok "Tunnel active: $CF_URL"
  # Save URL to .env for reference
  echo "" >> "$BOT_DIR/.env"
  echo "# Cloudflare tunnel URL (auto-generated, changes on restart)" >> "$BOT_DIR/.env"
  echo "ACTIVITY_TUNNEL_URL=$CF_URL" >> "$BOT_DIR/.env"
else
  print_warn "Could not capture tunnel URL yet. Check: cat /tmp/cloudflared.log"
  print_warn "The tunnel may still be starting. Run manually:"
  echo "  cloudflared tunnel --url http://localhost:${ACTIVITY_PORT}"
fi

# Install cloudflared as systemd service for auto-restart
if [ ! -f /etc/systemd/system/cloudflared.service ]; then
  sudo tee /etc/systemd/system/cloudflared.service > /dev/null <<EOF
[Unit]
Description=Cloudflare Tunnel for L6MH Activity
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:${ACTIVITY_PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable cloudflared
  print_ok "cloudflared service installed"
else
  print_ok "cloudflared service already exists"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 3: Bot Setup                                                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

print_step "10/10 — Bot + Activity Setup"
cd "$BOT_DIR"
if [ ! -d "discord-yt-audio-bot" ]; then
  git clone https://github.com/m7kor/L6mh.git discord-yt-audio-bot
fi
cd discord-yt-audio-bot
npm install

# Activity server dependencies
if [ -d "activity/server" ]; then
  cd activity/server && npm install && cd ../..
  print_ok "Activity server dependencies installed"
fi

# Build Activity client
if [ -d "activity/client" ]; then
  cd activity/client && npm install && npm run build && cd ../..
  print_ok "Activity client built"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 4: .env Configuration                                              ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

if [ -f .env ]; then
  ENV_EXISTED=true
  print_ok ".env already exists"
else
  cp .env.example .env
  print_warn ".env created from template — MUST be edited before starting!"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 5: Firewall + Ports                                                ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

STATUS_PORT_VAL=$(grep -E '^STATUS_PORT=' .env 2>/dev/null | cut -d '=' -f2)
if [ -n "$STATUS_PORT_VAL" ]; then
  sudo ufw allow "$STATUS_PORT_VAL/tcp" 2>/dev/null || true
  print_ok "Dashboard port $STATUS_PORT_VAL opened"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 6: Permissions + Cookies                                            ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

if [ -f cookies.txt ]; then
  chmod 600 cookies.txt
  print_ok "cookies.txt permissions set"
else
  print_warn "cookies.txt not found — place it manually and run: chmod 600 cookies.txt"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 7: Start Services                                                  ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

if [ "$ENV_EXISTED" = true ]; then
  # Deploy slash commands
  node src/deploy-commands.js 2>&1 || true

  # Start bot
  pm2 delete yt-audio-bot 2>/dev/null || true
  pm2 start src/index.js --name yt-audio-bot --max-memory-restart 300M

  # Start Activity server
  pm2 delete l6mh-activity 2>/dev/null || true
  cd activity/server && pm2 start index.js --name l6mh-activity && cd ../..

  # Start cloudflared service
  sudo systemctl start cloudflared 2>/dev/null || true

  pm2 save
  print_ok "All services started"
else
  print_warn "First run — edit .env before starting!"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  DONE — Summary                                                           ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                    🎉 Setup Complete!                        ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

if [ "$ENV_EXISTED" = false ]; then
  echo -e "${YELLOW}━━━ FIRST RUN — Required Steps ━━━${NC}"
  echo ""
  echo "1. Edit .env with your tokens:"
  echo "   nano $BOT_DIR/discord-yt-audio-bot/.env"
  echo ""
  echo "2. Place cookies.txt:"
  echo "   nano $BOT_DIR/discord-yt-audio-bot/cookies.txt"
  echo "   chmod 600 $BOT_DIR/discord-yt-audio-bot/cookies.txt"
  echo ""
  echo "3. Start everything:"
  echo "   cd $BOT_DIR/discord-yt-audio-bot"
  echo "   bash deploy-oracle.sh"
  echo ""
else
  echo -e "${GREEN}━━━ Services Running ━━━${NC}"
  echo ""
  echo "  🤖 Bot:          pm2 status yt-audio-bot"
  echo "  📊 Dashboard:    http://127.0.0.1:${STATUS_PORT_VAL:-3333}"
  echo "  📺 Activity:     http://127.0.0.1:3334"
  echo "  🌐 Tunnel:       $(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1 || echo 'check: cat /tmp/cloudflared.log')"
  echo ""
  echo -e "${YELLOW}━━━ Discord Developer Portal Setup ━━━${NC}"
  echo ""
  echo "1. Go to https://discord.com/developers/applications"
  echo "2. Select your app → Activities → Enable"
  echo "3. URL Mappings → ROOT: $(grep -oP '[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1 || echo '<tunnel-domain>')"
  echo "4. OAuth2 → Add CLIENT_SECRET to .env"
  echo ""
  echo -e "${YELLOW}━━━ How Members Open the Activity ━━━${NC}"
  echo ""
  echo "  Any member in the voice channel can:"
  echo "  1. Click 🚀 Activities below the channel list"
  echo "  2. Select 'راديو وحيد عمر'"
  echo "  3. Video syncs automatically for everyone!"
  echo ""
  echo "  Or use /شاشة command for instructions."
fi

echo ""
echo -e "${GREEN}━━━ Useful Commands ━━━${NC}"
echo ""
echo "  pm2 logs yt-audio-bot              — view bot logs"
echo "  pm2 logs l6mh-activity             — view activity logs"
echo "  pm2 restart yt-audio-bot           — restart bot"
echo "  pm2 restart l6mh-activity          — restart activity"
echo "  pm2 status                         — check all services"
echo "  sudo systemctl restart cloudflared — restart tunnel"
echo "  cat /tmp/cloudflared.log           — get new tunnel URL"
echo "  sudo docker logs bgutil-provider   — PoT provider logs"
echo "  sudo ufw status                    — firewall rules"
echo "  swapon --show                      — verify swap"
echo ""
