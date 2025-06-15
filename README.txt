cEDHSkill: A Discord Ranking Bot for Competitive EDH
TL;DR: Quick Setup Guide (for Windows)


Prerequisites (“for Dummies” section, if you know how to set up a Discord bot, you can skip all of this): 

1- You must have a Discord bot. You can create one here: https://discord.com/developers/applications

I recommend watching this popular video https://www.youtube.com/watch?app=desktop&v=KZ3tIGHU314 if you need any help (it’s a short video and you do not need to watch the rest of the series to set this up).

2- Make sure the bot is added to your Discord server. You should NOT need to give the bot any admin privileges. I’ve designed the bot so that it can function without requiring any of that.

3- If you’ve watched the YouTube video above, you should also know that another prerequisite to setting up the bot is to go into Developer Mode on your Discord account so you can right click on your server or users and copy IDs (you can go into Dev mode via your settings - either google how to do this or watch the video).

4- Lastly (and this should be obvious), you should have a computer you are willing to run this bot on continuously so that the bot will always be live. If you aren’t willing to keep a computer on for an entire month (or however long you want to run ranked), consider paying for cloud computing - I think Google offers this service (I think it’s called Google Colab). Or, if you have an existing service or someone that keeps something running for your Discord server, consider piggybacking off of them. If for some reason the bot gets disconnected, do not worry - your database file can be found in the /data folder and if you turn the bot back on, it should be able to retain all the player rating information (however you will not be able to “undo” stuff with /undo from before you disconnected).
—------------------------------------------------------------------------------------------

Steps to getting your bot set up for cEDH Skill once you have met all the prerequisites above: 

1- Clone the repo (Open up Command Prompt, and either type “git clone…” [you will need to install Git probably] 

or download the zip file containing all the source code to this project [top right corner of our GitHub page] 

and literally just extract the folder somewhere, copy the “URL”/directory [probably C:\…\cEDHSkill] and in your command prompt type “cd C:\…(whatever directory you put the folder in)” and hit enter.

Just make sure whichever directory you cd into, it contains the actual code [an empty data folder, a src folder, and a bunch of files] and is NOT just a directory with a singular folder called cEDHSkill): 

git clone https://github.com/isleep2late/cEDHSkill.git
cd cEDHSkill

2- Install Dependencies (after you cd into the folder, type and enter into command prompt):

npm install

(If you get some weird colored text after this and Command Prompt says you need to “fix” stuff, you can type “npm audit fix” and hit enter, though you really don’t have to. The one thing I would be careful of is using “npm audit fix –force” because there’s a chance that might break stuff and/or cause incompatibility issues.)

3- Configure the Bot:

 Edit the file src/config.ts with the following (Keep the apostrophes):

export const config = {
  token: 'YOUR_DISCORD_BOT_TOKEN',
  guildId: 'YOUR_DISCORD_SERVER_ID',
  admins: ['YOUR_DISCORD_USER_ID_1', 'YOUR_DISCORD_USER_ID_2']
};

[Please note: The bot is designed so that admins of the bot =/= admins of your server. You can add anyone (even regular users) and any amount of users to be admins and they will have the ability to use admin-only bot commands. This is intentional - some admins may not want to participate, and some non-admins may want to help run ranked seasons.]

4- Build and Register Commands (type into command prompt “npm run build”, hit enter, wait until you are allowed to type again, then type “npm run commands:register” and hit enter):

npm run build
npm run commands:register

Start the Bot (type and hit enter):

npm start

Overview
cEDHSkill is a TypeScript-based Discord bot tailored for managing competitive EDH (Commander) ranked seasons. It uses a custom-modified OpenSkill system incorporating mu, sigma, and a new dynamic variable tau for multiplayer complexity.
Key features:
Robust rating system with decay for inactivity
Match confirmation via reactions
Admin moderation tools
Boosting detection (anti-cheating)
Teams, scoring, # placement, fluid ranking support (optional)


cEDHSkill Rating System (Mu, Sigma, Tau)
Mu (μ): Represents estimated skill
Sigma (σ): Uncertainty/confidence
Tau (τ): Adjusts based on player count (hidden)
This system adapts ratings more accurately for multiplayer games, especially in pods of 3+ players. Tau is an innovative property of a match/pairings, whereas mu and sigma are properties of individual players. (Elo is not really a thing in cEDHSkill, or OpenSkill for that matter. The “Elo” score you see displayed with the bot is completely dependent on mu and sigma.)

Rating Decay
If a user doesn’t play ranked games, their mu decreases and sigma increases gradually.
Starts after 8 days of inactivity (configurable)
Occurs in a non-linear fashion as sigma approaches MAX_SIGMA (to more accurately approximate human memory decay)
Does not occur if your Elo is less than or equal to 1200
To customize decay timing, edit /src/job/decay.ts and adjust the inactivity threshold and decay formula.

Commands Overview
General User Commands
/rank @user1 w @user2 l @user3 l ...
Submits a ranked game
Supports: teams, scores, w/l/d, numeric placement, tied rankings (in “cEDH mode” only 3-4 players are accepted, and only 1 winner can be chosen or a draw scenario).
Requires all players to confirm via reaction (Unless you are an admin)

/list [X]
Displays Top X players (up to 50… but if #50 is tied with 51, 52… displays those tied players as well)

/playerinfo @user
Shows a user’s rating, mu, sigma, Elo, and W/L/D record (and their place in the top 50!)

/help
Opens help menu with sections:
Info, Rank, List, Player Info, Credits, and more

Admin Commands
/undo — Reverts the most recent match (can be used multiple times)

/redo — Re-applies the last undone match (can be used multiple times)

/snap — Deletes all pending (unconfirmed) matches (these should go away after 1 hr anyway I think)

/thanos-snap — Ends season and shows final top 50 (don’t use this when nobody has played a game lol)

/endgame — Reverses a Thanos Snap

/restrict @user — Bans user from ranked play

/vindicate @user — Unbans user from ranked and clears them of all suspicious activity

/reanimate @user — Undoes vindicate’s secondary effect, allowing said user to be flagged for suspicious activity again

!optout / !optin — Toggle DM notifications for suspicious activity (DM these to the bot directly for this to work, not in a public Discord server).


Anti-Boosting Detection
The bot:
Logs match history
Flags suspicious or unusual wins (admin-submitted games don’t count)
Notifies admins via DM
Admins can customize thresholds in rank.ts


Configuration (src/config.ts)
export const config = {
  token: 'YOUR_DISCORD_BOT_TOKEN',
  guildId: 'YOUR_DISCORD_SERVER_ID',
  admins: ['ADMIN_USER_ID1', 'ADMIN_USER_ID2']
};
token: Found in your Discord Developer Portal
guildId: Your server’s ID
admins: Array of admin Discord user IDs (strings)


Mac/Linux Setup Instructions
1- Ensure Node.js and npm are installed:
node -v
npm -v
If not installed:
brew install node        # macOS
sudo apt install nodejs # Ubuntu/Debian
2- Clone and enter the project directory:
git clone https://github.com/your-username/cEDHSkill.git
cd cEDHSkill
3- Install dependencies:
npm install
4- Edit src/config.ts with your credentials
5- Build and register commands:
npm run build
npm run commands:register
6- Run the bot:
npm start


Docker Deployment (Optional and idk what this is - AI wrote this part LOL)
Create a .env file:
DISCORD_TOKEN=your_token_here
GUILD_ID=your_guild_id_here
ADMINS=comma,separated,ids
Dockerfile:
FROM node:18
WORKDIR /app
COPY . .
RUN npm install && npm run build && npm run commands:register
CMD ["npm", "start"]
Build and run:
docker build -t cedhskill .
docker run --env-file .env cedhskill


Credits
Lead Developer: isleep2late
Rating Logic: J
Rating System: Based on OpenSkill
GitHub: https://github.com/philihp/openskill.js
Research: Weng & Lin’s publication https://www.csie.ntu.edu.tw/~cjlin/papers/online_ranking/online_journal.pdf
Contributions & Feedback
This project is open to contributions. If you have ideas for more features, optimizations, or want to report issues, open a GitHub issue or pull request: https://github.com/isleep2late/cEDHSkill/

Happy ranking!