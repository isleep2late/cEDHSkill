#!/bin/bash
# start-leaguebot.sh - Start the cEDH League Bot
# Runs in the foreground with output to both terminal and log file
#
# Usage:
#   ./start-leaguebot.sh          - Build and run (default)
#   ./start-leaguebot.sh --no-build  - Run without building first
#   ./start-leaguebot.sh --bg     - Run in background via screen (detachable)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/bot.log"

NO_BUILD=false
BACKGROUND=false

for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
    --bg) BACKGROUND=true ;;
  esac
done

# Build step
if [ "$NO_BUILD" = false ]; then
  echo "=== Building TypeScript... ==="
  npm run build
  if [ $? -ne 0 ]; then
    echo "Build failed! Fix errors before starting."
    exit 1
  fi
  echo "=== Build complete ==="
  echo ""
fi

if [ "$BACKGROUND" = true ]; then
  # Screen mode (like Mori's original script)
  # Creates a detachable screen session named "leaguebot"
  # Reattach with: screen -r leaguebot
  echo "Starting bot in screen session 'leaguebot'..."
  echo "Reattach with: screen -r leaguebot"
  echo "Log file: $LOG_FILE"
  screen -dmS leaguebot bash -c "cd $SCRIPT_DIR && node dist/loader.js 2>&1 | tee -a $LOG_FILE"
else
  # Foreground mode - see everything in terminal AND log to file
  echo "=== Starting cEDH League Bot ==="
  echo "Log file: $LOG_FILE"
  echo "Press Ctrl+C to stop"
  echo "================================"
  echo ""
  node dist/loader.js 2>&1 | tee -a "$LOG_FILE"
fi
