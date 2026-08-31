#!/bin/bash
# start-leaguebot.sh - Start the cEDH League Bot
# Runs in the foreground with output to both terminal and log file
#
# Usage:
#   ./start-leaguebot.sh          - Build and run (default)
#   ./start-leaguebot.sh --no-build  - Run without building first
#   ./start-leaguebot.sh --bg     - Run in background via screen (detachable)
#   ./start-leaguebot.sh --allow-multiple - Bypass the single-instance guard (rare)
#
# NOTE: this bot is normally managed by systemd (cedh-bot.service). Use
#       'systemctl --user restart cedh-bot' rather than running this by hand -
#       the service has Restart=always, so killing its node process just makes
#       systemd start a second copy 10 seconds later.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Detect if launched by double-click (no parent terminal to fall back to).
# If stdin is not a terminal, the file manager ran us without an interactive shell,
# so we should keep the window open on exit so the user can read any errors.
KEEP_OPEN=false
if [ -t 0 ] && [ -z "$INVOKED_FROM_DESKTOP" ]; then
  KEEP_OPEN=false
else
  KEEP_OPEN=true
fi

# Allow --keep-open flag to force this behavior
for arg in "$@"; do
  case $arg in
    --keep-open) KEEP_OPEN=true ;;
  esac
done

pause_if_needed() {
  if [ "$KEEP_OPEN" = true ]; then
    echo ""
    echo "Press Enter to close this window..."
    read -r
  fi
}

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/bot.log"

NO_BUILD=false
BACKGROUND=false
ALLOW_MULTIPLE=false

for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
    --bg) BACKGROUND=true ;;
    --allow-multiple) ALLOW_MULTIPLE=true ;;
  esac
done

# --- Single-instance guard ---------------------------------------------------
# Two copies of this bot on the same Discord token are actively harmful:
#   * both gateway sessions receive every interaction, so one always loses with
#     "DiscordAPIError[40060] Interaction has already been acknowledged"
#   * each copy runs `register-commands` below, and Discord's bulk-overwrite PUT
#     is delete-all-then-create-all rather than atomic. Two racing PUTs leave
#     BOTH sets registered, silently doubling every slash command in the server.
#     (That is exactly what happened 2026-08-29; it went unnoticed for two days.)
# The lock path is deliberately fixed rather than derived from $SCRIPT_DIR, so a
# copy started from a git worktree or a moved folder still collides with the
# running instance.
LOCK_FILE="/tmp/cedh-leaguebot-$(id -u).lock"

find_running_instances() {
  # Deliberately NOT `pgrep -f 'dist/loader.js'`: that matches any process whose
  # command line merely mentions the path - a grep, an editor, a deploy script -
  # and a false positive here would refuse a legitimate start. Since the unit has
  # Restart=always, that would turn into a restart loop and take the bot down.
  # So: require a real node process, running loader.js as an actual argv entry,
  # from a cEDHSkill working directory.
  local pid comm cwd
  for pid in /proc/[0-9]*; do
    pid="${pid#/proc/}"
    [ "$pid" = "$$" ] && continue
    read -r comm < /proc/"$pid"/comm 2>/dev/null || continue
    [ "$comm" = "node" ] || continue
    cwd="$(readlink -f /proc/"$pid"/cwd 2>/dev/null)" || continue
    case "$cwd" in
      *cEDHSkill*) ;;
      *) continue ;;
    esac
    if tr '\0' '\n' < /proc/"$pid"/cmdline 2>/dev/null | grep -qx '.*dist/loader\.js'; then
      echo "   pid $pid  ($cwd)"
    fi
  done
} 2>/dev/null

refuse_duplicate() {
  echo ""
  echo "=============================================================="
  echo " REFUSING TO START: a cEDH League Bot instance is already up."
  echo "=============================================================="
  local found
  found="$(find_running_instances)"
  [ -n "$found" ] && { echo "Already running:"; echo "$found"; echo ""; }
  echo "Two instances share one Discord token. They fight over every"
  echo "interaction and race each other's slash-command registration,"
  echo "which doubles every command in the server."
  echo ""
  echo "  Restart the bot:  systemctl --user restart cedh-bot"
  echo "  Stop the bot:     systemctl --user stop cedh-bot"
  echo "  Check status:     systemctl --user status cedh-bot"
  echo ""
  echo "If you truly need a second copy: ./start-leaguebot.sh --allow-multiple"
  pause_if_needed
  exit 1
}

if [ "$ALLOW_MULTIPLE" = true ]; then
  echo "!!! --allow-multiple given: single-instance guard DISABLED."
else
  # Cheap pre-check first: catches a live instance even if the lock was somehow
  # released early (e.g. a --bg/screen launch that did not inherit the fd).
  [ -n "$(find_running_instances)" ] && refuse_duplicate

  # Authoritative, race-free check. Append mode so a failed attempt cannot
  # truncate the lock file out from under the instance that holds it.
  if command -v flock >/dev/null 2>&1; then
    exec 9>>"$LOCK_FILE" || { echo "Could not open lock file $LOCK_FILE"; pause_if_needed; exit 1; }
    flock -n 9 || refuse_duplicate
  else
    echo "Note: 'flock' not available - relying on the process check only."
  fi
fi
# -----------------------------------------------------------------------------

if [ ! -d "node_modules" ]; then
  echo "node_modules not found. Run 'npm install' first."
  pause_if_needed
  exit 1
fi

if [ ! -f ".env" ]; then
  echo ".env file not found. Copy .env.example to .env and fill in your credentials."
  pause_if_needed
  exit 1
fi

# Build step
if [ "$NO_BUILD" = false ]; then
  echo "=== Building TypeScript... ==="
  npm run build
  if [ $? -ne 0 ]; then
    echo "Build failed! Fix errors before starting."
    pause_if_needed
    exit 1
  fi
  echo "=== Build complete ==="
  echo ""

  echo "=== Registering slash commands with Discord... ==="
  npm run register-commands
  if [ $? -ne 0 ]; then
    echo "Command registration failed! Check your .env credentials."
    pause_if_needed
    exit 1
  fi
  echo "=== Commands registered ==="
  echo ""
fi

if [ "$BACKGROUND" = true ]; then
  # Screen mode (like Mori's original script)
  # Creates a detachable screen session named "leaguebot"
  # Reattach with: screen -r leaguebot
  echo "Starting bot in screen session 'leaguebot'..."
  echo "Reattach with: screen -r leaguebot"
  echo "Log file: $LOG_FILE"
  screen -dmS leaguebot bash -c "cd $SCRIPT_DIR && node dist/loader.js 2>&1"
else
  # Foreground mode - see everything in terminal, logger writes to log file
  echo "=== Starting cEDH League Bot ==="
  echo "Log file: $LOG_FILE"
  echo "Press Ctrl+C to stop"
  echo "================================"
  echo ""
  node dist/loader.js 2>&1
  # If the bot exits (crash, error, Ctrl+C), keep window open if double-clicked
  pause_if_needed
fi
