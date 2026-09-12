#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Activity Screen Share Setup — One-click on local Windows               ║
# ║  Runs: Activity server + cloudflared tunnel                             ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BOT_DIR="C:\Project\discord-yt-streamer"
ACTIVITY_DIR="$BOT_DIR\activity\server"

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  📺 Activity Screen Share — Setup                     ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# Check CLIENT_SECRET
CLIENT_SECRET=$(grep -E '^CLIENT_SECRET=' "$BOT_DIR/.env" 2>/dev/null | cut -d '=' -f2)
if [ -z "$CLIENT_SECRET" ]; then
  echo -e "${YELLOW}⚠  CLIENT_SECRET is empty in .env${NC}"
  echo ""
  echo "You need to get CLIENT_SECRET from Discord Developer Portal:"
  echo "  1. Go to https://discord.com/developers/applications"
  echo "  2. Select your app (ID: 1542563301182144522)"
  echo "  3. OAuth2 → Client Secret → Copy"
  echo "  4. Add to .env: CLIENT_SECRET=your_secret_here"
  echo ""
  echo "Then run this script again."
  echo ""
  exit 1
fi

echo -e "${GREEN}✅ CLIENT_SECRET is set${NC}"

# Check if Activity server dependencies are installed
if [ ! -d "$ACTIVITY_DIR/node_modules" ]; then
  echo "Installing Activity server dependencies..."
  cd "$ACTIVITY_DIR" && npm install
fi

# Check if Activity client is built
if [ ! -d "$BOT_DIR/activity/client/dist" ]; then
  echo "Building Activity client..."
  cd "$BOT_DIR/activity/client" && npm install && npm run build
fi

echo ""
echo -e "${GREEN}━━━ Starting Activity Server ━━━${NC}"

# Kill existing activity server
taskkill //F //IM "node" //FI "WINDOWTITLE eq l6mh-activity*" 2>/dev/null || true

# Start activity server
cd "$ACTIVITY_DIR"
pm2 delete l6mh-activity 2>/dev/null || true
pm2 start index.js --name l6mh-activity
echo -e "${GREEN}✅ Activity server started on port 3334${NC}"

echo ""
echo -e "${GREEN}━━━ Starting Cloudflare Tunnel ━━━${NC}"

# Kill existing cloudflared
taskkill //F //IM "cloudflared.exe" 2>/dev/null || true

# Start cloudflared tunnel
start //B cloudflared tunnel --url http://localhost:3334
sleep 5

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  ✅ Setup Complete!                                   ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}━━━ Next Steps ━━━${NC}"
echo ""
echo "1. Get the tunnel URL from the cloudflared window"
echo "   (looks like: https://xxxx-xxxx.trycloudflare.com)"
echo ""
echo "2. Go to Discord Developer Portal:"
echo "   https://discord.com/developers/applications"
echo ""
echo "3. Select your app → Activities → Enable"
echo ""
echo "4. URL Mappings → ROOT MAPPING:"
echo "   Enter your tunnel domain (without https://)"
echo "   Example: xxxx-xxxx.trycloudflare.com"
echo ""
echo "5. In Discord voice channel:"
echo "   Click 🚀 Activities → Select 'راديو وحيد عمر'"
echo ""
echo "6. The video will appear synchronized for everyone!"
echo ""
