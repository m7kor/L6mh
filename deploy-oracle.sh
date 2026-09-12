#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Discord YT Audio Bot — Oracle Cloud Free Tier Setup                     ║
# ║  One-script deployment: bot + dashboard                                  ║
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

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 1: System Setup                                                    ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

print_step "1/8 — System Updates"
sudo apt update && sudo apt upgrade -y

print_step "2/8 — Swapfile (2GB for 1GB RAM instance)"
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

print_step "3/8 — Firewall"
if ! command -v ufw &> /dev/null; then
  sudo apt install -y ufw
fi
sudo ufw allow OpenSSH
sudo ufw --force enable
print_ok "Firewall configured"

print_step "4/8 — Node.js 20.x"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
print_ok "Node $(node -v) | npm $(npm -v)"

print_step "5/8 — ffmpeg"
if ! command -v ffmpeg &> /dev/null; then
  sudo apt install -y ffmpeg
fi
print_ok "ffmpeg installed"

print_step "6/8 — yt-dlp"
if ! command -v yt-dlp &> /dev/null; then
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
fi
print_ok "yt-dlp $(yt-dlp --version)"

print_step "7/8 — PM2"
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
  sudo pm2 startup systemd -u $USER --hp $HOME
fi
print_ok "PM2 installed"

print_step "8/8 — Docker + PoT Provider"
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
# ║  STEP 2: Bot Setup                                                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

print_step "Bot Setup"
cd "$BOT_DIR"
if [ ! -d "discord-yt-audio-bot" ]; then
  git clone https://github.com/m7kor/L6mh.git discord-yt-audio-bot
fi
cd discord-yt-audio-bot
npm install

if [ -f .env ]; then
  ENV_EXISTED=true
  print_ok ".env already exists"
else
  cp .env.example .env
  print_warn ".env created from template — MUST be edited before starting!"
fi

STATUS_PORT_VAL=$(grep -E '^STATUS_PORT=' .env 2>/dev/null | cut -d '=' -f2)
if [ -n "$STATUS_PORT_VAL" ]; then
  sudo ufw allow "$STATUS_PORT_VAL/tcp" 2>/dev/null || true
  print_ok "Dashboard port $STATUS_PORT_VAL opened"
fi

if [ -f cookies.txt ]; then
  chmod 600 cookies.txt
  print_ok "cookies.txt permissions set"
else
  print_warn "cookies.txt not found — place it manually and run: chmod 600 cookies.txt"
fi

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  STEP 3: Start Services                                                  ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

if [ "$ENV_EXISTED" = true ]; then
  node src/deploy-commands.js 2>&1 || true
  pm2 delete yt-audio-bot 2>/dev/null || true
  pm2 start src/index.js --name yt-audio-bot --max-memory-restart 300M
  pm2 save
  print_ok "Bot started"
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
  echo "  🤖 Bot:       pm2 status yt-audio-bot"
  echo "  📊 Dashboard: http://127.0.0.1:${STATUS_PORT_VAL:-3333}"
  echo ""
fi

echo ""
echo -e "${GREEN}━━━ Useful Commands ━━━${NC}"
echo ""
echo "  pm2 logs yt-audio-bot         — view bot logs"
echo "  pm2 restart yt-audio-bot      — restart bot"
echo "  pm2 status                    — check all services"
echo "  sudo docker logs bgutil-provider — PoT provider logs"
echo "  sudo ufw status               — firewall rules"
echo "  swapon --show                 — verify swap"
echo ""
