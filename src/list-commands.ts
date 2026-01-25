import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { config } from './config.js';

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log('\n📋 Checking registered commands...\n');

    console.log('Global commands:');
    const globalCommands = await rest.get(
      Routes.applicationCommands(config.clientId)
    ) as any[];

    if (globalCommands.length === 0) {
      console.log('  (none)');
    } else {
      globalCommands.forEach((cmd: any) => {
        console.log(`  - /${cmd.name}`);
      });
    }

    console.log('\nGuild commands:');
    const guildCommands = await rest.get(
      Routes.applicationGuildCommands(config.clientId, config.guildId)
    ) as any[];

    if (guildCommands.length === 0) {
      console.log('  (none)');
    } else {
      guildCommands.forEach((cmd: any) => {
        console.log(`  - /${cmd.name}`);
      });
    }

    console.log(`\nTotal: ${globalCommands.length + guildCommands.length} commands registered`);
    console.log(`Client ID: ${config.clientId}`);
    console.log(`Guild ID: ${config.guildId}\n`);

  } catch (error) {
    console.error('Error fetching commands:', error);
  }
})();
