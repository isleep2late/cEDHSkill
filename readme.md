# cEDHSkill v0.03: Enhanced Discord Ranking Bot for Competitive EDH

## 🚀 What's New in v0.03

### Rating System Enhancements

**New Features:**
- **Participation Bonus**: All players receive +1 Elo for every ranked game played (applied after all other calculations)
- **Linear Rating Decay**: After 6 days of inactivity, players lose -1 Elo per day (stops at 1050 Elo minimum)
- **Undoable Decay**: Both automatic (cron) and manual decay can be undone/redone via `/undo` and `/redo`
- **`/timewalk` Command**: Admin-only command to simulate time passing for decay testing (optional `days` parameter)
- **Smart `/view` Command**: Now auto-infers type from provided options (e.g., `/view player:@user` works without specifying `type:player`)

### Command Consolidation & Commander Assignment Fixes

**Major Changes:**
- **Unified `/view` Command**: Combines `/viewstats` and `/leaguestats` into one command with type selection (league, player, commander, game)
- **Renamed `/print` Command**: Simplified from `/printhistory` for easier access to history exports
- **Commander Assignment Fixes**: Critical fixes to prevent multiple commanders per player and ensure proper assignment behavior
- **Game View Feature**: NEW ability to view detailed game information by Game ID including all player ratings, W/L/D changes, and commander assignments
- **Enhanced History Exports**: `/print` now displays W/L/D correctly and includes complete audit trails

**Bug Fixes:**
- ✅ Fixed: Only ONE commander can be assigned per player per game (validation added)
- ✅ Fixed: `/rank` commander assignments now properly override default deck settings
- ✅ Fixed: `/set` with game ID now only affects that specific game (not all games)
- ✅ Fixed: `/set` default deck assignment no longer retroactively changes past games
- ✅ Fixed: `/view` game details now show commander assignments for each player
- ✅ Fixed: `/view` now infers type from provided options automatically
- ✅ Fixed: `/print` exports now include commander assignments in player and league history
- ✅ Fixed: W/L/D records display correctly in all history exports
- ✅ Fixed: Full league history export now retrieves ALL entries (removed artificial limits)

---

## TL;DR: Quick Setup Guide

### Prerequisites
1. **Create a Discord bot**: Visit https://discord.com/developers/applications
2. **Add bot to your server**: No admin privileges required for the bot
3. **Enable Developer Mode**: Required to copy Discord IDs (Settings → Advanced → Developer Mode)
4. **Dedicated hosting**: Keep the bot running continuously for persistent data

---

## Setup Instructions

### 0. Install Node.js
- Recommended: Node v22.12.0 or newer
- Node v18.x will NOT work

### 1. Download the Project
```bash
git clone https://github.com/isleep2late/cEDHSkill.git
cd cEDHSkill
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure the Bot
Edit `src/config.ts`:
```typescript
export const config = {
  token: 'YOUR_DISCORD_BOT_TOKEN',
  clientId: 'YOUR_BOT_CLIENT_ID',
  guildId: 'YOUR_DISCORD_SERVER_ID',
  admins: ['YOUR_DISCORD_USER_ID_1', 'YOUR_DISCORD_USER_ID_2'],
  moderators: ['YOUR_DISCORD_USER_ID'], // Add moderator user IDs here
  decayStartDays: 6  // Days of inactivity before decay starts
};
```

### 4. Build and Register Commands
```bash
npm run build
npm run commands:register
```

### 5. Start the Bot
```bash
npm start
```

---

## Complete Command Reference (16 Commands)

### 🎮 Unified Game Submission

#### `/rank` - Universal Game Submission
**Auto-detects mode based on input format:**

**Player Mode** (affects both player and assigned deck ratings):
```
/rank @user1 w @user2 l @user3 l @user4 d
/rank @user1 nekusar w @user2 meren 2 l @user3 najeela 1 l @user4 tymna 4 d
```
- Format: `@user [commander] [turn-order] w/l/d`
- Commander and turn order are optional
- **Only ONE commander per player per game** (validated)
- Commander specified in `/rank` overrides any default deck setting
- Assigned decks compete against phantom 1000 Elo decks for missing slots
- Requires all players to confirm (admins auto-confirm)

**Deck-Only Mode** (affects only deck ratings):
```
/rank nekusar-the-mindrazer w meren-of-clan-nel-toth l najeela-the-blade-blossom l thrasios-triton-hero-tymna-the-weaver l
```
- Format: `commander w/l/d commander w/l/d` (no @mentions)
- Turn order determined by input order
- Requires 2 confirmations from any users
- Works exactly like the old `/rankdeck` command

### ⚙️ Unified Settings

#### `/set` - Universal Settings Command
**For Regular Users:**
```bash
# Set default deck (affects FUTURE games only, NOT past games)
/set deck:nekusar-the-mindrazer

# Assign deck to specific game (only affects that ONE game)
/set deck:nekusar gameid:ABC123

# Set turn order for past game
/set gameid:ABC123 turnorder:2 (use 0 to remove turn order assignment)

# Assign deck to ALL games (past, present, future)
/set deck:nekusar gameid:allgames

# Remove deck assignment
/set deck:nocommander                    # Removes default (future games only)
/set deck:nocommander gameid:ABC123      # Removes from specific game only
/set deck:nocommander gameid:allgames    # Removes from ALL games
```

**Important Notes on Deck Assignment Behavior:**
- **Default Assignment (`/set deck:commander`)**: Only applies to NEW games from now on, does NOT change past games
- **Game-Specific Assignment (`/set deck:commander gameid:ABC123`)**: Only affects that ONE specific game, overrides default
- **All Games Assignment (`/set deck:commander gameid:allgames`)**: Changes ALL past, present, and future games (use carefully!)
- **Commander in `/rank` always overrides default**: If you specify a commander when submitting a game, it uses that commander regardless of default setting

**For Admins (additional features):**
```bash
# Set ratings for other players
/set target:@player elo:1200 wld:10/5/2

# Assign decks to other players
/set target:@player deck:nekusar-the-mindrazer gameid:allgames

# Combined operations
/set target:@player deck:nekusar elo:1200 gameid:ABC123 turnorder:3
```

### 📊 Statistics & Information

#### `/view` - Unified View Command (NEW in v0.03!)
**Replaces `/viewstats` and `/leaguestats` with enhanced functionality**

```bash
# View league statistics (default)
/view
/view type:league

# View player statistics (includes top 5 performing decks)
/view type:player player:@user

# View commander statistics
/view type:commander commander:nekusar-the-mindrazer

# NEW: View specific game details (shows all players, rating changes, commanders)
/view type:game gameid:ABC123
```

**Game View Shows:**
- All 4 players/decks with their results (🏆/🤝/💀)
- Rating BEFORE and AFTER the game for each player
- W/L/D records BEFORE and AFTER for each player
- Turn order assignments
- **Commander assignments** for each player
- Current ratings for comparison
- Game status (active/inactive)
- Admin submission indicator

#### `/list` - Rankings with Type Selection (using "Olympic" tie display)
```bash
# Show top players (default)
/list count:20

# Show top players explicitly
/list count:15 type:players

# Show top commanders/decks
/list count:25 type:decks
```

### 📈 Enhanced Statistics

#### `/predict` - Prediction System
- General turn order statistics across all players when used without arguments
- Enhanced prediction model for estimating game outcomes

### 👮‍♂️ Player Management
```bash
# Ban user from ranked games
/restrict @user

# Unban user and clear them of suspicion
/vindicate @user

# Remove suspicion exemption (allow flagging again)
/reanimate @user
```

### 🛠️ System Management
```bash
# Download database backup via DM
/backup

# Delete all unconfirmed game messages (both player and deck games)
/snap

# Undo the latest operation (game, /set command, or decay)
/undo

# Restore the most recently undone operation
/redo

# Simulate time passing for decay testing (Admin only)
/timewalk              # Default: simulates grace period + 1 days
/timewalk days:5       # Simulate 5 days passing
```

### 📋 History & Data Export

#### `/print` - Export History (RENAMED from `/printhistory`)
**Enhanced with complete audit trails and commander assignments**

```bash
# Export complete league history (now shows ALL entries, not limited)
/print

# Export specific player history (includes commander assignments)
/print target:@user

# Export specific commander history
/print target:commander-name

# Export filtered histories
/print target:decay        # All rating decay logs
/print target:setrank      # All manual rating adjustments
/print target:undo         # All undo/redo operations
/print target:admin        # Admin activity report
/print target:restricted   # Restricted players report
```

**Improvements in v0.03:**
- ✅ W/L/D records now display correctly in ALL exports
- ✅ Full league history retrieves ALL entries (no artificial limits)
- ✅ Commander assignments shown in player and game histories
- ✅ Complete audit trail with all rating changes

---

## 🔴 Admin Commands

**Admins have all moderator commands PLUS:**

### ⚙️ Enhanced Settings Management

#### `/set` - Admin Override Capabilities
```bash
# Set ratings for other players
/set target:@player elo:1200 wld:10/5/2

# Assign decks to other players (game-specific or default)
/set target:@player deck:nekusar-the-mindrazer gameid:ABC123

# Set game results directly
/set results:"@user1 w @user2 l @user3 l @user4 d"

# Modify commander ratings directly
/set target:nekusar-the-mindrazer elo:1300 wld:25/10/3

# Combined operations
/set target:@player deck:nekusar elo:1200 gameid:ABC123 turnorder:3

# Deactivate/reactivate games
/set gameid:GAMEID active:false
/set gameid:GAMEID active:true
```

### 🎮 Advanced Game Management
```bash
# Inject games anywhere in history with automatic recalculation
/rank aftergame:GAMEID @user1 w @user2 l @user3 l @user4 d

# Use aftergame:0 to inject game before all other games
/rank aftergame:0 @user1 w @user2 l @user3 l @user4 d

# Admin games are auto-confirmed (no player confirmation needed)
```

### 📊 Advanced History & Data Export
```bash
# Admin-only history exports
/print target:admin         # Admin activity report
/print target:decay         # All rating decay logs
/print target:setrank       # All manual rating adjustments
/print target:undo          # All undo/redo operations
/print target:restricted    # Restricted players report
```

### 🗃️ Season Management
```bash
# End season, show rankings, reset all data
/thanossnap
# (NOTE: /endgame NO LONGER exists! Functionality is in /thanossnap)
```

### 📧 Admin Notifications
**DM Commands for Admins:**
- `!optout` - Stop receiving suspicious activity alerts
- `!optin` - Resume receiving suspicious activity alerts

---

## New Features Deep Dive

### Commander Assignment System (v0.03 Fixes)

**How It Works:**
1. Players assign commanders using `/set deck:commander-name` OR specify in `/rank` when submitting games
2. When they play games, both their player rating AND their assigned deck rating are affected
3. If only some players have assigned decks, the system creates "phantom decks" with 1000 Elo for fair competition

**Assignment Priority (Highest to Lowest):**
1. **Commander specified in `/rank`**: Always takes precedence
2. **Game-specific assignment** (`/set deck:X gameid:ABC123`): Overrides default for that game
3. **Default deck** (`/set deck:X`): Used for new games where no specific assignment exists

**Assignment Types:**
- **Default Assignment**: `/set deck:nekusar-the-mindrazer` - Used for FUTURE games only (does NOT change past games)
- **Game-Specific**: `/set deck:nekusar-the-mindrazer gameid:ABC123` - Only for that ONE specific game
- **All Games**: `/set deck:nekusar-the-mindrazer gameid:allgames` - Retroactively assigns to ALL past games (use carefully!)

**Key Rules (v0.03 Enforced):**
- ✅ **Only ONE commander per player per game** - System validates and rejects multiple assignments
- ✅ **Commander in `/rank` overrides default** - Explicit assignment always wins
- ✅ **Game-specific assignments isolated** - Only affect the specified game, not others
- ✅ **Default assignments NOT retroactive** - Only apply to new games from that point forward

**Benefits:**
- Track both individual skill AND deck performance simultaneously
- See which commanders perform best for which players
- Maintain separate but linked ranking systems
- Enhanced statistics showing player-deck synergies
- Full transparency with `/view type:game` showing all assignments

### Unified View Command (NEW in v0.03)

The new `/view` command consolidates multiple commands into one interface:

**League View** (`/view` or `/view type:league`):
- Total players and commanders
- Qualification rates
- Turn order performance analysis
- Most played commanders
- System health indicators

**Player View** (`/view type:player player:@user`):
- Current rating and rank
- Win/loss/draw record
- Top 5 performing decks
- Turn order performance
- Recent game history

**Commander View** (`/view type:commander commander:name`):
- Current rating and rank
- Win/loss/draw record
- Turn order performance
- Top players using this deck
- Recent game history

**Game View** (`/view type:game gameid:ABC123`) - NEW!:
- All 4 players with results
- Rating changes (before → after)
- W/L/D changes (before → after)
- Turn order for each player
- **Commander assignments for each player**
- Game status and admin indicator

### Permission System Overview

| Feature | Regular Users | Moderators | Admins |
|---------|--------------|------------|--------|
| Submit games (`/rank`) | ✅ | ✅ | ✅ (auto-confirm) |
| Personal deck assignment | ✅ | ✅ | ✅ |
| View statistics (`/view`) | ✅ | ✅ | ✅ |
| Restrict/vindicate/reanimate | ❌ | ✅ | ✅ |
| Undo/redo operations | ❌ | ✅ | ✅ |
| System backups | ❌ | ✅ | ✅ |
| Basic history exports (`/print`) | ❌ | ✅ | ✅ |
| Modify other users' settings | ❌ | ❌ | ✅ |
| Admin history exports | ❌ | ❌ | ✅ |
| Season management | ❌ | ❌ | ✅ |
| Game injection | ❌ | ❌ | ✅ |
| Direct rating modification | ❌ | ❌ | ✅ |

### Phantom Deck System

When using player mode with deck assignments:
- **1 assigned deck + 3 unassigned players**: Assigned deck competes against 3 phantom 1000 Elo decks
- **2 assigned decks**: Both compete against 2 phantom decks
- **3 assigned decks**: All compete against 1 phantom deck
- **4 assigned decks**: Normal 4-deck competition

This ensures assigned decks receive fair rating changes regardless of how many other players have assignments.

### Rating Decay System (v0.03)

**How It Works:**
- Players who have played at least 1 ranked game are subject to rating decay
- After a configurable grace period (default: 6 days) of inactivity, decay begins
- Decay is **linear**: -1 Elo per day of inactivity beyond the grace period
- Decay stops at **1050 Elo** minimum (players cannot decay below this)
- Decay runs automatically at midnight via cron job

**Testing Decay with `/timewalk`:**
- Admins can use `/timewalk` to simulate time passing for decay testing
- **Parameters:**
  - `days` (optional): Number of days to simulate (1-365). Default: grace period + 1
- **Examples:**
  - `/timewalk` → Simulates enough days to trigger decay (grace period + 1)
  - `/timewalk days:10` → Simulates 10 days passing
- The command does NOT modify `lastPlayed` timestamps - it only simulates time for the decay check
- This is intended for testing purposes only and should not be used in production
- Both automatic and manual decay operations are fully undoable via `/undo`

**Configuration:**
- Set `DECAY_START_DAYS` in your `.env` file or `decayStartDays` in `config.ts`
- Default grace period: 6 days

**Edge Case - Game Deactivation and Decay:**
- When a game is deactivated via `/set gameid:ABC active:false`, all ratings are recalculated from scratch
- **Decay is NOT re-applied during recalculation** - this is intentional
- The recalculation provides a "clean slate" based purely on game history, which is useful for correcting mistakes
- After recalculation, the decay timer resets for all affected players
- If you need to preserve decay, avoid deactivating games that would trigger a full recalculation

### Participation Bonus (v0.03)

**How It Works:**
- All players receive +1 Elo for every ranked game they participate in
- The bonus is applied AFTER all OpenSkill calculations and minimum rating changes
- Works with both player games and hybrid games (where decks are assigned)
- Fully integrated with `/undo` and `/redo` operations

### Enhanced Undo/Redo System

The unified undo system now handles:
- **Player games with deck assignments**: Reverts both player and deck ratings
- **Deck-only games with player assignments**: Reverts both deck and player ratings
- **Rating decay operations**: Both automatic (cron) and manual (`/timewalk`) decay can be undone
- **Mixed scenarios**: Properly handles any combination of assignments
- **Complete audit trail**: Every change is logged and reversible
- **Moderator/Admin Access**: Both moderators and admins can undo/redo operations

---

## Technical Architecture

### Database Enhancements
- **player_deck_assignments**: Table tracking game-specific deck assignments
- **Enhanced matches table**: Includes `assignedDeck` column
- **Enhanced deck_matches table**: Includes `assignedPlayer` column
- **Comprehensive indexes**: Optimized for new query patterns

### Rating System Integration
- Phantom deck calculations using OpenSkill rating system
- Simultaneous player and deck rating updates
- Turn order tracking across both systems
- Enhanced 3-player penalty calculations

### Audit Trail System
- Complete logging of all rating changes
- Deck assignment tracking
- Admin and moderator action monitoring
- Exportable history reports with complete W/L/D records

---

## Migration from v0.02 to v0.03

The bot automatically handles the transition:
1. **Preserves all existing ratings** for both players and decks
2. **Maintains game history** with enhanced tracking
3. **No database schema changes** required
4. **Commander assignments remain intact**

**Breaking Changes:**
- `/viewstats` removed → Use `/view type:player` or `/view type:commander`
- `/leaguestats` removed → Use `/view` or `/view type:league`
- `/printhistory` removed → Use `/print`

**All functionality preserved** - just consolidated for easier use!

---

## Configuration Options

### Basic Configuration (`src/config.ts`)
```typescript
export const config = {
  token: 'YOUR_DISCORD_BOT_TOKEN',
  clientId: 'YOUR_BOT_CLIENT_ID',
  guildId: 'YOUR_DISCORD_SERVER_ID',
  admins: ['ADMIN_USER_ID1', 'ADMIN_USER_ID2'],
  moderators: ['MOD_USER_ID'],
  decayStartDays: 6 // Days of inactivity before decay starts
};
```

### Advanced Customization
- **Phantom Deck Rating**: Default 1000 Elo (μ=25.0, σ=8.333)
- **Rating Decay**: Linear -1 Elo/day after grace period, stops at 1050 Elo
- **Participation Bonus**: +1 Elo per ranked game played
- **Minimum Rating Changes**: Adjustable in unified `rank.ts`
- **Qualification Requirements**: 5 games minimum (customizable)

---

## Troubleshooting

### Common Issues
- **Commands not working**: Run `npm run commands:register` after updates
- **Database migration errors**: Check write permissions in `/data` folder
- **Deck assignments not working**: Verify commander names against EDHREC
- **Multiple commanders error**: Only assign ONE commander per player per game
- **Default deck changing past games**: Use `/set deck:X` NOT `/set deck:X gameid:allgames`

### Data Management
- **Manual Backups**: Use `/backup` command
- **Database Location**: `data/cEDHSkill.db`
- **View Game Details**: Use `/view type:game gameid:ABC123`

---

## Command Changes in v0.03

**Removed Commands** (functionality consolidated):
- `/viewstats` → Use `/view type:player` or `/view type:commander`
- `/leaguestats` → Use `/view` or `/view type:league`
- `/printhistory` → Use `/print`

**New Commands:**
- `/timewalk [days]` - Admin-only command to simulate time passing for decay testing
- `/help` - Updated with new rating system information

**New Features:**
- `/view type:game gameid:ABC123` - View detailed game information
- `/view` now auto-infers type from provided options (e.g., `/view player:@user` works)
- Enhanced `/print` with complete audit trails
- Commander assignment validation in `/rank`
- Fixed `/set` behavior for game-specific assignments
- Participation bonus: +1 Elo for every ranked game played
- Linear rating decay: -1 Elo/day after 6-day grace period (stops at 1050)
- `/undo` and `/redo` now support decay operations

**All functionality preserved** with improved usability!

---

## Future Roadmap

- **Enhanced Prediction Models**: Machine learning integration for win probability
- **Tournament Mode**: Bracket management and Swiss pairings
- **Advanced Analytics**: Player-commander synergy analysis
- **Mobile Integration**: Discord slash command optimization for mobile users
- **API Endpoints**: External integration capabilities
- **Deck Performance Tracking**: Enhanced statistics for commander matchups

---

## Credits & Acknowledgments

- **Primary Developer**: isleep2late
- **Rating System**: OpenSkill (Weng-Lin Bayesian Rating)
- **Framework**: Discord.js v14
- **Database**: SQLite with comprehensive audit trails
- **Commander Validation**: EDHREC API integration
- **Special Thanks**: cEDH community for extensive testing and feedback

---

## License & Contributing

MIT License - Open source and community-driven development welcome.

**GitHub Repository**: [cEDHSkill](https://github.com/isleep2late/cEDHSkill)

For bug reports, feature requests, or contributions, please visit the GitHub repository.