#!/bin/bash
# start-leaguebot.command - Start the cEDH League Bot (macOS)
# Double-click this file in Finder after setting up .env
# macOS will open a Terminal window automatically.
#
# Usage (from terminal):
#   ./start-leaguebot.command            - Build and run (default)
#   ./start-leaguebot.command --no-build - Run without building first

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "node_modules not found. Run 'npm install' first."
  echo "Press any key to exit..."
  read -n 1
  exit 1
fi

if [ ! -f ".env" ]; then
  echo ".env file not found. Copy .env.example to .env and fill in your credentials."
  echo "Press any key to exit..."
  read -n 1
  exit 1
fi

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/bot.log"

NO_BUILD=false

for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
  esac
done

# Build step
if [ "$NO_BUILD" = false ]; then
  echo "=== Building TypeScript... ==="
  npm run build
  if [ $? -ne 0 ]; then
    echo "Build failed! Fix errors before starting."
    echo "Press any key to exit..."
    read -n 1
    exit 1
  fi
  echo "=== Build complete ==="
  echo ""
fi

echo "=== Starting cEDH League Bot ==="
echo "Log file: $LOG_FILE"
echo "Press Ctrl+C to stop (or close this window)"
echo "================================"
echo ""
node dist/loader.js 2>&1 | tee -a "$LOG_FILE"
