# cEDHSkill v0.02: Enhanced Discord Ranking Bot for Competitive EDH

## 🚀 What's New in v0.02

### Major System Overhaul: Unified Commands & Deck Assignment System

**Key Features:**
- **Unified `/rank` Command**: Automatically detects player mode (with @mentions) or deck-only mode. Supports game injection for mods.
- **Player-Deck Assignment System**: Players can assign commanders to themselves for dual tracking
- **Phantom Deck Calculations**: Assigned decks compete against virtual 1000 Elo opponents when needed
- **Unified `/set` Command**: Combines "setrank" (admins) and "setturnorder" with deck assignment capabilities
- **Enhanced Admin Tools**: Comprehensive audit trails and history exports
- **Unified Statistics**: `/viewstats` replaces playerinfo and deckinfo with enhanced features
- **Enhanced prediction**: Three-tiered model for predicting winners.

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
  decayStartDays: 8
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

## Complete Command Reference

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
# Set default deck
/set deck:nekusar-the-mindrazer

# Assign deck to specific game
/set deck:nekusar gameid:ABC123

# Set turn order for past game
/set gameid:ABC123 turnorder:2 (use 0 to remove turn order assignment)

# Assign deck to all past games
/set deck:nekusar gameid:allgames

# Remove deck assignment
/set deck:nocommander
/set deck:nocommander gameid:ABC123
```

**For Admins (additional features):**
```bash
# Set ratings for other players
/set user:@player elo:1200 wld:10/5/2

# Assign decks to other players
/set user:@player deck:nekusar-the-mindrazer gameid:allgames

# Combined operations
/set user:@player deck:nekusar elo:1200 gameid:ABC123 turnorder:3
```

### 📊 Statistics & Information

#### `/viewstats` - Universal Stats Command
```bash
# View player statistics (includes top 5 performing decks)
/viewstats player:@user

# View commander statistics
/viewstats commander:nekusar-the-mindrazer
```

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

#### `/leaguestats` - Comprehensive League Overview
- Total players and commanders used in the league
- Qualification rates and activity metrics
- Turn order performance analysis
- Most played commanders
- System health indicators

##### `/predict` - Prediction System
- General turn order statistics across all players when used without arguments
- Enhanced prediction model for estimating game outcomes

#### 👮‍♂️ Player Management
```bash
# Ban user from ranked games
/restrict @user

# Unban user and clear them of suspicion
/vindicate @user

# Remove suspicion exemption (allow flagging again)
/reanimate @user
```

#### 🛠️ System Management
```bash
# Download database backup via DM
/backup

# Delete all unconfirmed game messages (both player and deck games)
/snap

# Undo the latest operation (game or /set command)
/undo

# Restore the most recently undone operation
/redo
```

#### 📋 History & Data Export
```bash
# Export detailed history to text file (various filtering options)
/printhistory [target]

# Available targets:
/printhistory                    # Complete league history
/printhistory player:@user       # Specific player history
/printhistory commander:deck-name # Specific deck history
```

### 🔴 Admin Commands

**Admins have all moderator commands PLUS:**

#### ⚙️ Enhanced Settings Management

##### `/set` - Admin Override Capabilities
**For Admins (can modify other users and ratings):**
```bash
# Set ratings for other players
/set target:@player elo:1200 wld:10/5/2

# Assign decks to other players
/set target:@player deck:nekusar-the-mindrazer gameid:allgames

# Set game results directly
/set results:"@user1 w @user2 l @user3 l @user4 d"

# Modify commander ratings directly
/set target:nekusar-the-mindrazer elo:1300 wld:25/10/3

# Combined operations
/set target:@player deck:nekusar elo:1200 gameid:ABC123 turnorder:3

# Deactivate games
/set gameid:GAMEID active:false
```

#### 🎮 Advanced Game Management
```bash
# Inject games anywhere in history with automatic recalculation
/rank aftergame:GAMEID @user1 w @user2 l @user3 l @user4 d
# Use aftergame:0 to inject game before all other games

# Admin games are auto-confirmed (no player confirmation needed)
```

#### 📊 Advanced History & Data Export
```bash
# Admin-only history exports
/printhistory target:admin      # Admin activity report
/printhistory target:players    # All players report
/printhistory target:decay      # All rating decay logs
/printhistory target:setrank    # All manual rating adjustments
/printhistory target:undo       # All undo/redo operations
/printhistory target:restricted # Restricted players report
```

#### 🗃️ Season Management
```bash
# End season, show rankings, reset all data
/thanossnap (NOTE:/endgame NO LONGER exists! It is baked into thanossnap by sending a backup to all moderators/admins)

```

#### 📧 Admin Notifications
**DM Commands for Admins:**
- `!optout` - Stop receiving suspicious activity alerts
- `!optin` - Resume receiving suspicious activity alerts

---

## New Features Deep Dive

### Player-Deck Assignment System

**How It Works:**
1. Players assign commanders to themselves using `/set deck:commander-name`
2. When they play games, both their player rating AND their assigned deck rating are affected
3. If only some players have assigned decks, the system creates "phantom decks" with 1000 Elo for fair competition

**Assignment Types:**
- **Default Assignment**: `/set deck:nekusar-the-mindrazer` - Used for all future games
- **Game-Specific**: `/set deck:nekusar-the-mindrazer gameid:ABC123` - Only for that specific game  
- **All Games**: `/set deck:nekusar-the-mindrazer gameid:allgames` - Retroactively assigns to all past games

**Benefits:**
- Track both individual skill AND deck performance simultaneously
- See which commanders perform best for which players
- Maintain separate but linked ranking systems
- Enhanced statistics showing player-deck synergies

### Permission System Overview

| Feature | Regular Users | Moderators | Admins |
|---------|--------------|------------|--------|
| Submit games (`/rank`) | ✅ | ✅ | ✅ (auto-confirm) |
| Personal deck assignment | ✅ | ✅ | ✅ |
| View statistics | ✅ | ✅ | ✅ |
| Restrict/vindicate/reanimate | ❌ | ✅ | ✅ |
| Undo/redo operations | ❌ | ✅ | ✅ |
| System backups | ❌ | ✅ | ✅ |
| Basic history exports | ❌ | ✅ | ✅ |
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

### Enhanced Undo/Redo System

The unified undo system now handles:
- **Player games with deck assignments**: Reverts both player and deck ratings
- **Deck-only games with player assignments**: Reverts both deck and player ratings  
- **Mixed scenarios**: Properly handles any combination of assignments
- **Complete audit trail**: Every change is logged and reversible
- **Moderator/Admin Access**: Both moderators and admins can undo/redo operations

---

## Technical Architecture

### Database Enhancements
- **player_deck_assignments**: New table tracking all deck assignments
- **Enhanced matches table**: Now includes `assignedDeck` column
- **Enhanced deck_matches table**: Now includes `assignedPlayer` column
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
- Exportable history reports with appropriate permission filtering

---
## Migration from v0.01

The bot automatically migrates existing data:
1. **Preserves all existing ratings** for both players and decks
2. **Maintains game history** with enhanced tracking
3. **Adds new columns** to existing database tables
4. **Imports deck assignments** from existing match data where possible

**No data loss** - all your existing league data remains intact while gaining new features.

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
  decayStartDays: 8 // Days before decay starts
};
```

### Advanced Customization
- **Phantom Deck Rating**: Default 1000 Elo (μ=25.0, σ=8.333)
- **Decay Parameters**: Configurable in `bot.ts`
- **Minimum Rating Changes**: Adjustable in unified `rank.ts`
- **Qualification Requirements**: 5 games minimum (customizable)

---

## Troubleshooting

### Common Issues
- **Commands not working**: Run `npm run commands:register` after updates
- **Database migration errors**: Check write permissions in `/data` folder
- **Deck assignments not working**: Verify commander names against EDHREC
- **Performance issues**: Database includes new indexes for optimization

### Data Management
- **Manual Backups**: Use `/backup` command
- **Database Location**: `data/cEDHSkill.db`

---

## Command Deprecation Notice

**Removed Commands** (functionality moved to unified commands):
- `/rankdeck` → Use `/rank` with deck-only format
- `/playerinfo` → Use `/viewstats player:@user`
- `/deckinfo` → Use `/viewstats commander:name`
- `/setrank` → Use `/set` with rating parameters
- `/setturnorder` → Use `/set` with turn order parameters
- `/listdeck` → Use `/list type:decks`

**All functionality preserved** in the new unified commands with enhanced features.

---

## Future Roadmap

- **Enhanced Prediction Models**: Machine learning integration for win probability
- **Tournament Mode**: Bracket management and Swiss pairings
- **Advanced Analytics**: Detailed meta analysis and trend tracking
- **Mobile Integration**: Discord slash command optimization for mobile users
- **API Endpoints**: External integration capabilities

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