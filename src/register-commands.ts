import 'dotenv/config';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const commands = [];
const commandsPath = path.join(__dirname, '../dist/commands');

// Check if commands directory exists
if (!fs.existsSync(commandsPath)) {
  console.error('❌ Commands directory not found. Make sure to run "npm run build" first.');
  process.exit(1);
}

const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

console.log(`\n📦 cEDHSkill v0.04 - Command Registration`);
console.log(`Found ${commandFiles.length} command files:\n`);

const expectedCommands = [
  'backup.js',
  'help.js',
  'list.js',
  'predict.js',
  'print.js',        // RENAMED from printhistory.js
  'rank.js',
  'reanimate.js',
  'redo.js',
  'restrict.js',
  'set.js',
  'snap.js',
  'thanossnap.js',
  'timewalk.js',     // Admin-only: fast-forward decay cycle for testing
  'undo.js',
  'view.js',         // NEW unified command (replaces viewstats.js and leaguestats.js)
  'vindicate.js'
];

// Check for expected files
const missingFiles = expectedCommands.filter(cmd => !commandFiles.includes(cmd));
const unexpectedFiles = commandFiles.filter(file => !expectedCommands.includes(file));

if (missingFiles.length > 0) {
  console.warn('⚠️  Missing expected command files:');
  missingFiles.forEach(file => console.warn(`   - ${file}`));
  console.warn('');
}

if (unexpectedFiles.length > 0) {
  console.warn('⚠️  Found unexpected command files (these will still be registered):');
  unexpectedFiles.forEach(file => console.warn(`   - ${file}`));
  console.warn('');
}

// Load all command files
for (const file of commandFiles) {
  try {
    const filePath = path.join(commandsPath, file);
    const command = await import(pathToFileURL(filePath).href);
    
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
      console.log(`✅ Registered: /${command.data.name.padEnd(15)} - ${command.data.description}`);
    } else {
      console.warn(`⚠️  Skipped ${file}: missing data or execute export`);
    }
  } catch (error) {
    console.error(`❌ Failed to load ${file}:`, error);
  }
}

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log('\n🔄 Clearing old global commands...');
    await rest.put(Routes.applicationCommands(config.clientId), { body: [] });

    console.log('🔄 Clearing old guild commands...');
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [] });

    console.log(`📝 Registering guild commands for server: ${config.guildId}...\n`);
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );

    console.log(`\n🎉 Successfully registered ${commands.length} commands for cEDHSkill v0.04!`);
    console.log('✅ Commands registered for your cEDH server only');
    console.log('💡 Commands update instantly for guild-specific registration\n');
    
    // Display command summary by category
    console.log('📋 Command Summary:');
    console.log('');
    console.log('🎮 Game Management:');
    console.log('   /rank        - Submit game results (player or deck mode)');
    console.log('   /set         - Manage settings, deck assignments, and ratings');
    console.log('');
    console.log('📊 Statistics & Information:');
    console.log('   /view        - View league, player, commander, or game stats');
    console.log('   /list        - Show rankings (players or commanders)');
    console.log('   /predict     - Prediction system for game outcomes');
    console.log('   /print       - Export detailed history to text files');
    console.log('');
    console.log('👮‍♂️ Player Management:');
    console.log('   /restrict    - Ban user from ranked games');
    console.log('   /vindicate   - Unban user and clear suspicion');
    console.log('   /reanimate   - Remove suspicion exemption');
    console.log('');
    console.log('🛠️ System Management:');
    console.log('   /backup      - Download database backup');
    console.log('   /snap        - Delete unconfirmed game messages');
    console.log('   /undo        - Undo latest operation');
    console.log('   /redo        - Restore undone operation');
    console.log('   /thanossnap  - End season and reset data (admin only)');
    console.log('   /timewalk    - Fast-forward decay cycle (admin only)');
    console.log('   /help        - Show help for commands');
    console.log('');
    
    // Verify expected command count
    const EXPECTED_COMMAND_COUNT = 16;
    if (commands.length !== EXPECTED_COMMAND_COUNT) {
      console.warn(`⚠️  Warning: Expected ${EXPECTED_COMMAND_COUNT} commands but registered ${commands.length}`);
      console.warn('   This may indicate missing or extra command files.');
    } else {
      console.log(`✅ All ${EXPECTED_COMMAND_COUNT} commands registered successfully!`);
    }
    
    console.log('');
    console.log('📖 Changes in v0.04 (stability & bug fixes — no rating math changed):');
    console.log('   • Fixed: player 👍 game confirmations work again (restored GuildMessageReactions intent)');
    console.log('   • Fixed: "ghost games" — games are now confirmed only after results are written');
    console.log('   • Fixed: crash-safe shutdown — database WAL is checkpointed on SIGINT/SIGTERM');
    console.log('   • Fixed: clearer admin auto-confirm embed (labels pre-game ratings)');
    console.log('');
    
  } catch (error) {
    console.error('\n❌ Error registering commands:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
    process.exit(1);
  }
})();