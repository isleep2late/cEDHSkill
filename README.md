# cEDHSkill

A Discord bot for competitive EDH (Commander) ranked games using [OpenSkill](https://github.com/philihp/openskill.js) (Weng-Lin Bayesian Rating).

## Features

- **Dual Rating Systems** - Separate rankings for players and commanders/decks
- **OpenSkill-Based Elo** - `Elo = 1000 + 25 * (mu - 3 * sigma)`
- **Participation Bonus** - +1 Elo for every ranked game played (max 5 per day)
- **Rating Decay** - Sigma-based inactivity decay (increases uncertainty, preserves skill)
- **Turn Order Tracking** - Track performance by seat position
- **Game Injection** - Insert historical games at any point in the timeline
- **Undo/Redo** - Full operation history with decay timer preservation

## Setup

1. Clone the repository
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your Discord credentials:
   - `DISCORD_TOKEN` - Your bot token
   - `CLIENT_ID` - Your application's client ID
   - `GUILD_ID` - Your server's guild ID
   - `ADMINS` - Comma-separated admin user IDs
   - `MODERATORS` - Comma-separated moderator user IDs (optional)
   - `DECAY_START_DAYS` - Days before decay begins (default: 6)
4. `npm run build`
5. `npm run register-commands`
6. Start the bot using one of the methods below

> **Optional:** Grant the bot **Manage Messages** permission in your Discord server to allow automatic reaction cleanup during turn order selection. The bot works without this, but players may need to manually remove their old reactions when changing turn order picks.

## Running the Bot

Once your `.env` is configured and you've run `npm install` + `npm run build` + `npm run register-commands`, you can start the bot by **double-clicking** a startup script or running it from a terminal.

### Quick Start (Double-Click)

| OS | File | How |
|----|------|-----|
| **Linux** | `start-leaguebot.desktop` | Double-click in your file manager — opens a terminal window automatically |
| **macOS** | `start-leaguebot.command` | Double-click in Finder — a Terminal window opens automatically |
| **Windows** | `start-leaguebot.bat` | Double-click in File Explorer — a Command Prompt window opens automatically |

> **Linux note:** Double-clicking `.sh` files directly won't open a terminal on most Linux file managers — they run silently in the background. Use the `.desktop` file instead, which tells your file manager to open a terminal. If your file manager asks you to "Trust and Launch" it, go ahead — it just runs `start-leaguebot.sh` under the hood.

All scripts will build the project and then start the bot. Output is shown in the terminal window and saved to `logs/bot.log`. *Make sure you go into the .desktop file via text editor and replace the directory `"$(dirname "%k")"` with your actual folder location!*

### Terminal Usage

If you prefer running from a terminal:

```bash
# Linux / macOS
./start-leaguebot.sh            # Build + run (output visible in terminal + log file)
./start-leaguebot.sh --no-build # Skip build, just run
./start-leaguebot.sh --bg       # Run in background via screen (detachable)

# Windows (Command Prompt)
start-leaguebot.bat             # Build + run
start-leaguebot.bat --no-build  # Skip build, just run

# Any OS (npm)
npm start                       # Runs node dist/loader.js directly (no log file)
```

- **Default mode** keeps the terminal open so you can watch all bot activity in real time.
- **Background mode** (`--bg`, Linux/macOS only) runs via `screen` — reattach with `screen -r leaguebot`.
- Both modes write to `logs/bot.log` simultaneously.

### Stopping the Bot

- **If the terminal window is visible:** Press `Ctrl+C` to stop the bot.
- **If you can't find the terminal window** (e.g. you double-clicked the script and the window is hidden):
  ```bash
  # Linux / macOS — find the bot process
  pgrep -af "node.*loader.js"

  # Kill it by name (only kills the bot, nothing else)
  pkill -f "node.*loader.js"

  # Windows (Command Prompt or PowerShell)
  tasklist | findstr "node"
  taskkill /F /IM node.exe    &REM kills all node processes — use with caution
  ```
- **If running in a screen session** (`--bg`): `screen -r leaguebot` to reattach, then `Ctrl+C`.

### Logging

All bot activity is logged to both the terminal and `logs/bot.log`:

- **Command logging** - Every slash command is logged with the user, server, options, execution time, and result
- **Internal operations** - Decay, undo/redo, snapshots, recalculations, database migrations, cleanup, and EDHREC validation
- **Log rotation** - Files auto-rotate at 10MB, keeping 5 previous log files (`bot.log.1` through `bot.log.5`)
- **Log levels** - `[INFO]`, `[WARN]`, `[ERROR]`, `[DEBUG]`, `[CMD]`, `[CMD-DONE]`, `[CMD-ERR]`

Example log output:
```
[2025-01-15T20:30:00.000Z] [CMD] /rank | User: player1 (123456) | Guild: 789012 | Options: {"type":"aftergame"}
[2025-01-15T20:30:02.341Z] [CMD-DONE] /rank | User: 123456 | 2341ms | success
```

## Commands

| Command | Description |
|---------|-------------|
| `/rank` | Submit game results (player or deck mode) |
| `/list` | Show top players or decks (default 100, max 200) |
| `/view` | View player, deck, game, or league stats |
| `/predict` | Predict win chances for a game |
| `/set` | Set default commander or modify ratings (admin) |
| `/undo` | Revert the most recent operation (admin) |
| `/redo` | Reapply the most recently undone operation (admin) |
| `/help` | Show detailed help for all commands |

## Tips & Tricks

### Game Injection

- `/rank aftergame:start` or `aftergame:0` - Inject a game **before** all other games (very first game of the league)
- `/rank aftergame:GAMEID` - Inject a game after a specific game ID. The timestamp is automatically set to the midway point between that game and the next one.
- All injected games trigger a full rating recalculation of the entire season.

### Commander Assignment

- `/set deck:commander-name` - Set your default commander for future games
- `/set deck:nocommander` - Remove your default commander
- `/set deck:nocommander gameid:ABC123` - Remove a commander assignment from a specific game
- `/set deck:nocommander gameid:allgames` - Remove commander from all of your games

### Phantom Decks

In a player game, if some players have commanders assigned and others don't, the system creates "phantom" decks for unassigned players. Phantoms inherit the game result (win/loss/draw) of the player they represent, so commander ratings stay accurate even in mixed games.

You can also use `phantom` as a participant in `/predict` to fill a seat with a default 1000 Elo player.

### Duplicate Commanders

Multiple players can use the same commander in one game. The system handles duplicate commanders by giving each instance its own rating calculation, then aggregating the results (average mu, minimum sigma, summed W/L/D) for the final database update.

### Game Modification (Admin)

- `/set gameid:ABC123 active:false` - Deactivate a game (removes it from ratings)
- `/set gameid:ABC123 active:true` - Reactivate a game
- `/set gameid:ABC123 results:@user1 w @user2 l ...` - Overwrite game results
- All modifications trigger a full recalculation of the entire season.

### Undo/Redo

- `/undo` - Revert the most recent operation (game, `/set` change, or decay cycle)
- `/undo gameid:ABC123` - Revert a specific game
- `/redo` - Reapply the most recently undone operation
- Decay timers are preserved - undoing yesterday's game won't reset the decay clock.
- The undo/redo history is kept in memory and capped at **100 operations** to prevent unbounded memory growth. When the 101st operation is recorded, the oldest entry is automatically evicted. This means only the most recent 100 operations are undoable at any given time.

### Rating Decay

Inactivity decay reduces a player's displayed Elo by increasing **sigma** (uncertainty) rather than decreasing **mu** (skill). This follows the philosophy used by most competitive games: being inactive means we're less confident in your rating, not that you've gotten worse.

**How it works:**
- After a configurable grace period (default: 6 days), inactive players lose **-1 Elo per day**
- Decay is achieved by increasing sigma by **+0.25 per day** (since each sigma point = 4 Elo penalty in the formula)
- **Mu (skill) is never touched by decay** — only sigma (uncertainty) increases
- Decay stops when a player's Elo reaches the floor of **1050**
- Playing a game resets the decay timer

**Why sigma-based decay?**
- A player's estimated skill level (mu) is preserved through inactivity
- When they return, their higher sigma causes OpenSkill to weight new game results more heavily
- This means ratings reconverge quickly after returning — a few games and you're back to a confident rating
- It's a more accurate model: not playing doesn't make you worse, it just makes us less sure of where you stand

**Example:** A player with 1066 Elo (mu=27.5, sigma=4.0) stops playing.
| Day | Sigma | Elo | Notes |
|-----|-------|-----|-------|
| 1–6 | 4.00 | 1066 | Grace period — no decay |
| 7 | 4.25 | 1065 | First day of decay |
| 8 | 4.50 | 1064 | |
| 9 | 4.75 | 1063 | |
| ... | ... | ... | Continues -1/day |
| 22 | 8.00 | 1050 | Floor reached — decay stops |

The grace period is configurable via the `DECAY_START_DAYS` environment variable.

**Decay during recalculation:** When games are replayed, decay is interleaved chronologically between games. Timewalk events (`/timewalk`) are also replayed in order, ensuring ratings stay consistent after any recalculation.

**When does a full recalculation happen?** A full recalculation resets all ratings and replays every game from scratch in chronological order (with decay interleaved). This is triggered by:

- **Game injection** — `/rank` with the `aftergame` parameter (inserting a historical game into the timeline)
- **Game modification** — `/set gameid:<ID>` when changing `active` status, `results`, or deck assignments for a specific game or all games
- **Undo/Redo** — `/undo` or `/redo` of a game modification or deck assignment
- **Bot startup** — Automatically on the first startup, and whenever `DECAY_START_DAYS` has changed since the last run. This ensures decay is retroactively reapplied with the updated grace period.

Normal `/rank` games (no `aftergame`) and `/set deck:<name>` without a `gameid` (setting a default) do **not** trigger a full recalculation.

## Credits

- **Lead developer:** isleep2late
- **Dev Team:** J (initial logic integration) & AEtheriumSlinky (additional logic)
- **OpenSkill:** https://github.com/philihp/openskill.js
- **Research:** https://www.csie.ntu.edu.tw/~cjlin/papers/online_ranking/online_journal.pdf
