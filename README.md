# cEDHSkill

A Discord bot for competitive EDH (Commander) ranked games using [OpenSkill](https://github.com/philihp/openskill.js) (Weng-Lin Bayesian Rating).

## Features

- **Dual Rating Systems** - Separate rankings for players and commanders/decks
- **OpenSkill-Based Elo** - `Elo = 1000 + (mu - 25) * 12 - (sigma - 8.333) * 4`
- **Participation Bonus** - +1 Elo for every ranked game played
- **Rating Decay** - Inactivity decay after a configurable grace period
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
6. `./start-leaguebot.sh` (recommended) or `npm start`

## Running the Bot

### Startup Script (Recommended)

```bash
./start-leaguebot.sh            # Build + run (output visible in terminal + log file)
./start-leaguebot.sh --no-build # Skip build, just run
./start-leaguebot.sh --bg       # Run in background via screen (detachable)
```

- **Default mode** keeps the terminal open so you can watch all bot activity in real time.
- **Background mode** (`--bg`) runs via `screen` - reattach with `screen -r leaguebot`.
- Both modes write to `logs/bot.log` simultaneously.

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
| `/list` | Show top players or decks |
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

## Credits

- **Lead developer:** isleep2late
- **Dev Team:** J (initial logic integration) & AEtheriumSlinky (additional logic)
- **OpenSkill:** https://github.com/philihp/openskill.js
- **Research:** https://www.csie.ntu.edu.tw/~cjlin/papers/online_ranking/online_journal.pdf
