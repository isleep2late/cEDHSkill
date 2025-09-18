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
  console.error('Commands directory not found. Make sure to run "npm run build" first.');
  process.exit(1);
}

const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

console.log(`Found ${commandFiles.length} command files:`);
console.log(commandFiles.map(f => `  - ${f}`).join('\n'));

for (const file of commandFiles) {
  try {
    const filePath = path.join(commandsPath, file);
    const command = await import(pathToFileURL(filePath).href);
    
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
      console.log(`✅ Registered command: ${command.data.name}`);
    } else {
      console.warn(`⚠️  Command at ${file} missing data or execute export`);
    }
  } catch (error) {
    console.error(`❌ Failed to load command ${file}:`, error);
  }
}

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log('\n🔄 Clearing global commands...');
    await rest.put(Routes.applicationCommands(config.clientId), { body: [] });

    console.log('📝 Registering guild commands...');
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    
    console.log(`\n🎉 Successfully registered ${commands.length} commands:`);
    commands.forEach(cmd => console.log(`   - /${cmd.name}: ${cmd.description}`));
    
  } catch (error) {
    console.error('❌ Error registering commands:', error);
    process.exit(1);
  }
})();