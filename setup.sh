#!/bin/bash
# ============================================
# Atheism — One-Command Setup
# ============================================
# Usage:
#   ./setup.sh              # Start on default port 3000
#   ./setup.sh 4000         # Start on port 4000
#   ./setup.sh --install    # Start + install OpenClaw plugin + auto-configure
#
# What it does:
#   1. Installs dependencies (npm install)
#   2. Starts the server
#   3. Waits for it to be ready
#   4. (with --install) Installs OpenClaw plugin and auto-configures openclaw.json
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
PORT=3000
DO_INSTALL=false
HOST="0.0.0.0"

# Parse args
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=true ;;
    [0-9]*) PORT="$arg" ;;
  esac
done

echo ""
echo "🚀 Atheism Setup"
echo "   Port: $PORT"
echo ""

# Step 1: Install dependencies
if [ ! -d "$SERVER_DIR/node_modules" ]; then
  echo "📦 Installing dependencies..."
  cd "$SERVER_DIR"
  npm install --production 2>&1 | tail -1
  echo ""
else
  echo "📦 Dependencies already installed"
fi

# Step 2: Check if port is in use
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "⚠️  Port $PORT is already in use"
  # Check if it's already an Atheism server
  if curl -s "http://localhost:$PORT/for-agents" 2>/dev/null | grep -q "a2a-space"; then
    echo "   ✅ Atheism is already running on port $PORT"
    BASE_URL="http://localhost:$PORT"
  else
    echo "   Please free port $PORT or use: ./setup.sh <other-port>"
    exit 1
  fi
else
  # Step 3: Start server
  echo "🔧 Starting server..."
  cd "$SERVER_DIR"
  PORT="$PORT" HOST="$HOST" nohup node server.js > /tmp/atheism-server.log 2>&1 &
  SERVER_PID=$!
  echo "   PID: $SERVER_PID (log: /tmp/atheism-server.log)"

  # Step 4: Wait for ready
  echo "⏳ Waiting for server..."
  for i in $(seq 1 30); do
    if curl -s "http://localhost:$PORT/for-agents" 2>/dev/null | grep -q "a2a-space"; then
      echo "   ✅ Server ready"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "   ❌ Server failed to start. Check /tmp/atheism-server.log"
      exit 1
    fi
    sleep 1
  done
  BASE_URL="http://localhost:$PORT"
fi

echo ""
echo "🌐 Web UI:    $BASE_URL"
echo "🤖 Agent API: $BASE_URL/for-agents"

# Step 5: Install OpenClaw plugin (if requested)
if [ "$DO_INSTALL" = true ]; then
  echo ""
  echo "📦 Installing OpenClaw plugin..."
  curl -sL "$BASE_URL/api/plugin/install-script" | bash
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Atheism is running!"
echo ""
echo "Next steps:"
echo "  • Open $BASE_URL in your browser"
echo "  • Create a Space and start collaborating"
if [ "$DO_INSTALL" = false ]; then
  echo "  • To connect OpenClaw: ./setup.sh --install"
  echo "  • Or manually: curl -sL $BASE_URL/api/plugin/install-script | bash"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
