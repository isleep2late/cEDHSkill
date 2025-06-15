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
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = await import(pathToFileURL(filePath).href); // ✅ critical fix
    if ('data' in command && 'execute' in command) {
        commands.push(command.data.toJSON());
    }
}

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
    try {
          // 1) Clear global
  console.log('🗑️ Clearing global commands…');
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });

        console.log('🔁 Registering application (/) commands...');
        await rest.put(
            Routes.applicationGuildCommands(config.clientId, config.guildId),
            { body: commands }
        );
        console.log('✅ Successfully registered application commands.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
})();
