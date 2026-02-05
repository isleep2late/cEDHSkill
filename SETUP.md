# Local Development Setup Guide

This guide will help you set up the cEDH Skill Ranking Bot on your local Linux computer.

## Prerequisites

- **Node.js v22.12.0 or higher** (v18.x is NOT supported)
- **npm** (comes with Node.js)
- **Git**
- **A Discord Bot Token** (instructions below)

---

## Step 1: Install Node.js

Check if you have Node.js installed:

```bash
node --version
```

If you need to install or update Node.js, use one of these methods:

### Option A: Using nvm (Recommended)
```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Reload your shell
source ~/.bashrc  # or source ~/.zshrc

# Install Node.js v22
nvm install 22
nvm use 22
```

### Option B: Using your package manager
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Fedora
sudo dnf install nodejs

# Arch Linux
sudo pacman -S nodejs npm
```

---

## Step 2: Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" section in the left sidebar
4. Click "Add Bot"
5. Under the bot's username, click "Reset Token" and copy the token (you'll need this later)
6. Enable these Privileged Gateway Intents:
   - Server Members Intent
   - Message Content Intent
7. Go to the "OAuth2" section, then "URL Generator"
8. Select these scopes:
   - `bot`
   - `applications.commands`
9. Select these bot permissions:
   - Send Messages
   - Embed Links
   - Attach Files
   - Read Message History
   - Use Slash Commands
10. Copy the generated URL at the bottom and open it in your browser to invite the bot to your server

---

## Step 3: Get Your Discord IDs

You'll need several Discord IDs. First, enable Developer Mode:

1. Open Discord
2. Go to User Settings (gear icon)
3. Go to "Advanced"
4. Enable "Developer Mode"

Now you can right-click on things to copy their IDs:

- **Server/Guild ID**: Right-click your server name → "Copy Server ID"
- **Your User ID**: Right-click your username → "Copy User ID"
- **Other Admin/Mod IDs**: Right-click their usernames → "Copy User ID"

---

## Step 4: Clone the Repository

```bash
# Clone the repository
git clone <repository-url>

# Navigate into the directory
cd cEDHSkill
```

---

## Step 5: Install Dependencies

```bash
npm install
```

This will install all required packages including Discord.js, SQLite, and TypeScript.

---

## Step 6: Configure Your Bot

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit the .env file with your information:**
   ```bash
   nano .env
   # or use your preferred editor: vim, gedit, kate, etc.
   ```

3. **Fill in your values:**
   ```env
   DISCORD_TOKEN=your_actual_bot_token_here
   CLIENT_ID=your_bot_client_id_here
   GUILD_ID=your_server_id_here
   ADMINS=your_user_id,another_admin_id
   MODERATORS=moderator_id_1,moderator_id_2
   DECAY_START_DAYS=8
   ```

   **Where to find each value:**
   - `DISCORD_TOKEN`: From Step 2, when you clicked "Reset Token"
   - `CLIENT_ID`: Discord Developer Portal → Your Application → "Application ID" (on the General Information page)
   - `GUILD_ID`: From Step 3, your server ID
   - `ADMINS`: Comma-separated list of Discord user IDs who should have admin permissions
   - `MODERATORS`: Comma-separated list of Discord user IDs who should have moderator permissions
   - `DECAY_START_DAYS`: Number of days before player ratings start to decay (optional, defaults to 6)

4. **Save and exit** (in nano: Ctrl+X, then Y, then Enter)

**Important:** The `.env` file is already in `.gitignore`, so it won't be committed to Git. Never share your bot token publicly!

---

## Step 7: Build the Bot

Compile the TypeScript code to JavaScript:

```bash
npm run build
```

---

## Step 8: Register Discord Commands

Before running the bot for the first time, register the slash commands:

```bash
npm run commands:register
```

You should see output indicating that commands were registered successfully.

---

## Step 9: Run the Bot

You have two options:

### Production Mode
```bash
npm start
```

### Development Mode (with hot reload)
```bash
npm run dev
```

If everything is configured correctly, you should see:
```
Connected to database
Logged in as YourBotName#1234
```

---

## Step 10: Test the Bot

In your Discord server, try typing `/` and you should see the bot's slash commands appear. Try:

```
/help
```

This should display the help information for the bot.

---

## Troubleshooting

### "Missing required environment variables"
- Make sure your `.env` file exists in the root directory
- Check that all required variables are set (DISCORD_TOKEN, CLIENT_ID, GUILD_ID)
- Make sure there are no extra spaces around the `=` signs

### "An invalid token was provided"
- Double-check your DISCORD_TOKEN in the `.env` file
- Make sure you copied the entire token
- Try resetting the token in the Discord Developer Portal

### Commands don't appear in Discord
- Make sure you ran `npm run commands:register`
- Wait a few minutes (can take up to an hour for global commands)
- Try kicking and re-inviting the bot
- Make sure the bot has the "applications.commands" scope

### Database errors
- The `data/` directory and database file will be created automatically
- If you get permission errors, check that the bot has write permissions in the project directory

### Node.js version issues
- This bot requires Node.js v22.12.0 or higher
- Version 18.x is NOT supported
- Check your version with `node --version`

---

## Project Structure

```
cEDHSkill/
├── src/                  # TypeScript source code
│   ├── bot.ts           # Main bot logic
│   ├── loader.ts        # Entry point
│   ├── config.ts        # Configuration (reads from .env)
│   ├── commands/        # Slash command implementations
│   ├── db/              # Database utilities
│   └── utils/           # Helper functions
├── dist/                # Compiled JavaScript (generated by npm run build)
├── data/                # SQLite database (created at runtime)
├── .env                 # Your configuration (DO NOT COMMIT)
├── .env.example         # Template for .env
├── .gitignore           # Git ignore rules
├── package.json         # Dependencies and scripts
└── readme.md            # Full documentation
```

---

## Available Commands

Once the bot is running, see the full list of commands in the main `readme.md` or use `/help` in Discord.

Key commands include:
- `/rank` - Submit game results
- `/list` - View player/deck rankings
- `/view` - View detailed player/deck stats
- `/predict` - Predict game outcomes
- `/set` - Configure settings (admin/mod only)

---

## Stopping the Bot

Press `Ctrl+C` in the terminal where the bot is running.

---

## Updating the Bot

```bash
# Pull latest changes
git pull

# Install any new dependencies
npm install

# Rebuild
npm run build

# Re-register commands (if commands changed)
npm run commands:register

# Restart the bot
npm start
```

---

## Getting Help

- Check the main `readme.md` for detailed command documentation
- Look at the troubleshooting section in `readme.md`
- Review the configuration options in `.env.example`

---

## Security Notes

- **Never commit your `.env` file** - it's already in `.gitignore`
- **Never share your Discord bot token** - treat it like a password
- If your token is exposed, reset it immediately in the Discord Developer Portal
- Keep your dependencies updated: `npm update`

---

## Next Steps

- Read the full documentation in `readme.md`
- Configure your rating decay settings with `/set`
- Set up your first game with `/rank`
- Explore the prediction system with `/predict`

Happy ranking! 🎮
