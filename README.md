# cEDHSkill v0.03 Beta

A Discord bot for competitive EDH (Commander) ranked games using [OpenSkill](https://github.com/philihp/openskill.js) (Weng-Lin Bayesian Rating).

## Features

- **Dual Rating Systems** - Separate rankings for players and commanders/decks
- **OpenSkill-Based Elo** - `Elo = 1000 + 25 * (mu - 3 * sigma)`
- **Participation Bonus** - +1 Elo per ranked game played (max 5 per day per player/deck)
- **Rating Decay** - Sigma-based inactivity decay (increases uncertainty, preserves skill)
- **Turn Order Tracking** - Track performance by seat position
- **Game Injection** - Insert historical games at any point in the timeline
- **Undo/Redo** - Full operation history with decay timer preservation
- **Suspicious Activity Detection** - Automated pattern detection for unusual play
- **EDHREC Validation** - Commander names are validated against EDHREC data

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

---

## Commands

### Permission Levels

cEDHSkill has three permission tiers, configured via environment variables:

| Level | Configured In | Description |
|-------|---------------|-------------|
| **All Users** | n/a | Any server member can use these commands |
| **Admin/Mod** | `ADMINS` and `MODERATORS` in `.env` | Administrative commands for managing the league |
| **Admin Only** | `ADMINS` in `.env` | Sensitive operations that only top-level admins can perform |

---

### All Users

#### `/rank`
Submit game results for players and/or commanders.

| Option | Required | Description |
|--------|----------|-------------|
| `results` | Yes | Results string with @users and/or commander names followed by `w`/`l`/`d` |
| `aftergame` | No | **Admin only.** Inject this game after a specific game ID. Use `start` or `0` to insert before all games |

**Player mode:** Mention 3-4 players with their results. Commanders can optionally be included inline.
```
/rank results: @Alice w @Bob l @Carol l @Dave l
/rank results: @Alice w Kinnan l @Carol l Tymna/Thrasios d
```

**Deck-only mode:** When no @users are mentioned, the command enters deck-only mode. Order determines turn order (first = Turn 1, etc.).
```
/rank results: Kinnan w Najeela l Tymna/Thrasios l Sisay l
```

**Turn order:** Can be specified inline with a number after the result (`@user w 1` = Turn 1), or via emoji reactions after the game is posted.

**Game confirmation:** After submitting, all mentioned players must react to confirm the game before ratings are applied.

#### `/list`
Show the leaderboard for players or commanders.

| Option | Required | Description |
|--------|----------|-------------|
| `count` | No | Number of entries to show, 1-200 (default: 100) |
| `type` | No | `Players` (default) or `Decks/Commanders` |

Entries show Elo, mu/sigma, W/L/D record, and qualification status (minimum 5 games required).

#### `/view`
View detailed statistics for the league, a player, a commander, or a specific game.

| Option | Required | Description |
|--------|----------|-------------|
| `type` | No | `League Stats` (default), `Player`, `Commander`, `Game`, `Win % (Players)`, `Win % (Commanders)` |
| `player` | No | @mention a player to view (for Player type) |
| `commander` | No | Commander name (for Commander type) |
| `gameid` | No | Game ID (for Game type) |
| `count` | No | Number of entries for Win % types, 1-200 (default: 100) |

- **League Stats** - Total players, games played, qualification rates, activity metrics, draw rate
- **Player** - Rating, rank, W/L/D, win rate, top 5 decks, turn order performance
- **Commander** - Rating, rank, W/L/D, win rate, turn order performance
- **Game** - All participants, rating changes, commanders, turn orders
- **Win %** - Top players/commanders ranked by win percentage

#### `/predict`
Predict win chances for a hypothetical game or view overall turn order statistics.

| Option | Required | Description |
|--------|----------|-------------|
| `participants` | No | 1-4 participants: `@user`, `commander-name`, or `phantom` (comma-separated) |

Without input, shows aggregate turn order win percentages across all players. With participants, shows Elo-based, turn-order-based, and hybrid win probability predictions. Use `phantom` to fill a seat with a default 1000 Elo player.

#### `/set` (User Features)
Set your own default commander or turn order for a specific game.

| Option | Required | Description |
|--------|----------|-------------|
| `deck` | No | Commander name to assign as your default (use `nocommander` to remove) |
| `gameid` | No | Apply to a specific game ID, or `allgames` for all past and future games |
| `turnorder` | No | Turn order (1-4) for the specified game, or `0` to remove |

Regular users can only modify their own settings. Admin-only options for `/set` are listed below.

#### `/help`
Show help for cEDHSkill commands. Admin-specific sections are only visible to admins.

| Option | Required | Description |
|--------|----------|-------------|
| `section` | Yes | `Info`, `Player Commands`, `Deck Commands`, `Stats Commands`, `Admin Commands`, `Tips & Tricks`, `Credits` |

---

### Admin/Mod Commands

These commands require the user's Discord ID to be listed in `ADMINS` or `MODERATORS` in the `.env` file.

#### `/undo`
Revert the most recent operation (game, `/set` change, or decay cycle).

Decay timers are preserved — undoing yesterday's game won't reset the decay clock. The undo history is capped at **100 operations**; when the 101st operation is recorded, the oldest entry is evicted.

#### `/redo`
Reapply the most recently undone operation.

If the undo involved a game whose participants were cleaned up (0/0/0 record), `/redo` automatically recreates them.

#### `/backup`
Download a copy of the SQLite database file via DM.

#### `/restrict`
Ban a user from participating in ranked games.

| Option | Required | Description |
|--------|----------|-------------|
| `user` | Yes | @mention the user to restrict |

#### `/vindicate`
Unban a restricted user and clear them of any suspicion flags.

| Option | Required | Description |
|--------|----------|-------------|
| `user` | Yes | @mention the user to unrestrict |

#### `/reanimate`
Remove a player's suspicion exemption, allowing the system to flag them again for suspicious activity.

| Option | Required | Description |
|--------|----------|-------------|
| `user` | Yes | @mention the player to remove from the exemption list |

#### `/snap`
Delete all unconfirmed game messages currently in limbo (both player games and deck-only games).

#### `/print`
Export league history to a text file with filtering options.

| Option | Required | Description |
|--------|----------|-------------|
| `target` | No | Filter: blank (full history), `@user`, `commander-name`, `decay`, `set`, `undo`, `admin`, `restricted` |

#### `/set` (Admin Features)
When used by an admin, `/set` gains additional capabilities. Admins can target other users, modify ratings directly, and alter game records.

**Targeting other players (admin only):**
```
/set target:@user mu:26.0 sigma:7.5
/set target:@user elo:1100
/set target:@user wld:10/5/2
/set target:@user deck:Kinnan
```

**Modifying game records (admin only):**
```
/set target:GAMEID active:false          # Deactivate a game
/set target:GAMEID active:true           # Reactivate a game
/set target:GAMEID results:@user1 w @user2 l @user3 l @user4 l   # Overwrite results
```

**Modifying commander ratings (admin only):**
```
/set target:Kinnan mu:26.0 sigma:7.0
/set target:Kinnan elo:1100
/set target:Kinnan wld:8/3/1
```

**Full recalculation (admin only):**
```
/set recalculate:true                    # Recalculate all player and deck ratings from scratch
```

| Admin-Only Option | Description |
|-------------------|-------------|
| `mu` | Set mu (skill) rating directly |
| `sigma` | Set sigma (uncertainty) rating directly |
| `elo` | Set Elo rating (adjusts mu to match) |
| `wld` | Set win/loss/draw record (format: `wins/losses/draws`) |
| `active` | Set game active status (`true`/`false`) |
| `results` | Overwrite game results |
| `recalculate` | Trigger a full recalculation of all ratings |

All game modifications trigger a full recalculation of the entire season.

---

### Admin-Only Commands

These commands require the user's Discord ID to be listed in `ADMINS` in the `.env` file. **Moderators cannot use these.**

#### `/timewalk`
Simulate time passing for decay testing. Uses a per-player virtual clock so that players who play games mid-timewalk aren't incorrectly decayed.

| Option | Required | Description |
|--------|----------|-------------|
| `days` | No | Number of days to simulate, 1-90 (default: minimum needed for next decay event) |

Virtual time is cumulative across multiple `/timewalk` invocations and resets on recalculation or bot restart. For testing purposes only.

#### `/thanossnap`
End the current ranked season. Creates a database backup, generates the final leaderboards for qualified players (5+ games, top 64 with ties) and qualified decks, then resets all data for the next season.

---

## How Ratings Work

### The Elo Formula

```
Elo = 1000 + 25 * (mu - 3 * sigma)
```

- **mu** represents estimated skill (starts at 25.0)
- **sigma** represents uncertainty/confidence in the rating (starts at 8.333)
- New players start at approximately **1000 Elo**
- As you play more games, sigma decreases (more confidence), which raises your displayed Elo
- Winning increases mu; losing decreases it

### Participation Bonus

Every ranked game awards a **+1 Elo participation bonus**, applied as a mu increase (sigma stays unchanged). This bonus is capped at **5 per day** per player and per deck — the first 5 games on a given calendar day (UTC) earn the bonus, and any games beyond that do not. The display text will show `+ 0 (daily bonus limit reached)` when the cap is hit.

### Minimum Rating Changes

To prevent stale matchups, the system enforces minimum rating changes:
- **Winners** always gain at least **+2 Elo**
- **Losers** always lose at least **-2 Elo**
- **Draws** have no minimum

### 3-Player Penalty

When a game has only 3 players (if enabled), a **0.9x penalty** is applied to mu changes to account for the reduced competition.

### Rating Decay

Inactivity decay reduces a player's displayed Elo by increasing **sigma** (uncertainty) rather than decreasing **mu** (skill). This follows the philosophy used by most competitive games: being inactive means we're less confident in your rating, not that you've gotten worse.

**How it works:**
- After a configurable grace period (default: 6 days), inactive players lose **-1 Elo per day**
- Decay is achieved by increasing sigma — with the current formula, each +1/75 sigma = -1 Elo
- **Mu (skill) is never touched by decay** — only sigma (uncertainty) increases
- Decay stops when a player's Elo reaches the floor of **1050**
- Playing a game resets the decay timer

**Why sigma-based decay?**
- A player's estimated skill level (mu) is preserved through inactivity
- When they return, their higher sigma causes OpenSkill to weight new game results more heavily
- This means ratings reconverge quickly after returning — a few games and you're back to a confident rating
- It's a more accurate model: not playing doesn't make you worse, it just makes us less sure of where you stand

The grace period is configurable via the `DECAY_START_DAYS` environment variable.

**Decay during recalculation:** When games are replayed, decay is interleaved chronologically between games. Timewalk events (`/timewalk`) are also replayed in order, ensuring ratings stay consistent after any recalculation.

### Qualification

A minimum of **5 games** is required to appear in official rankings (the `/list` leaderboard). Unqualified players still have ratings and can be viewed individually via `/view`.

---

## Tips & Tricks

### Game Injection (Admin)

- `/rank aftergame:start` or `aftergame:0` — Inject a game **before** all other games (very first game of the league)
- `/rank aftergame:GAMEID` — Inject a game after a specific game ID. The timestamp is automatically set to the midway point between that game and the next one.
- All injected games trigger a full rating recalculation of the entire season.

### Commander Assignment

- `/set deck:commander-name` — Set your default commander for future games
- `/set deck:nocommander` — Remove your default commander
- `/set deck:nocommander gameid:ABC123` — Remove a commander assignment from a specific game
- `/set deck:nocommander gameid:allgames` — Remove commander from all of your games

### Phantom Decks

In a player game, if some players have commanders assigned and others don't, the system creates "phantom" decks for unassigned players. Phantoms inherit the game result (win/loss/draw) of the player they represent, so commander ratings stay accurate even in mixed games.

You can also use `phantom` as a participant in `/predict` to fill a seat with a default 1000 Elo player.

### Duplicate Commanders

Multiple players can use the same commander in one game. The system handles duplicate commanders by giving each instance its own rating calculation, then aggregating the results (average mu, minimum sigma, summed W/L/D) for the final database update.

### Undo/Redo Details

- `/undo` — Revert the most recent operation (game, `/set` change, or decay cycle)
- `/redo` — Reapply the most recently undone operation
- Decay timers are preserved — undoing yesterday's game won't reset the decay clock.
- The undo/redo history is kept in memory and capped at **100 operations** to prevent unbounded memory growth. When the 101st operation is recorded, the oldest entry is automatically evicted.

### When Does a Full Recalculation Happen?

A full recalculation resets all ratings and replays every game from scratch in chronological order (with decay interleaved). This is triggered by:

- **Game injection** — `/rank` with the `aftergame` parameter
- **Game modification** — `/set gameid:<ID>` when changing `active` status, `results`, or deck assignments
- **Manual recalculate** — `/set recalculate:true`
- **Undo/Redo** — `/undo` or `/redo` of a game modification or deck assignment
- **Bot startup** — Automatically on the first startup, and whenever `DECAY_START_DAYS` has changed since the last run

Normal `/rank` games (no `aftergame`) and `/set deck:<name>` without a `gameid` (setting a default) do **not** trigger a full recalculation.

---

## Credits

- **Lead developer:** isleep2late
- **Dev Team:** J (initial logic integration) & AEtheriumSlinky (additional logic)
- **OpenSkill:** https://github.com/philihp/openskill.js
- **Research:** https://www.csie.ntu.edu.tw/~cjlin/papers/online_ranking/online_journal.pdf
