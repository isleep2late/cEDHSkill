import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { config } from './config.js';

const rest = new REST({ version: '10' }).setToken(config.token);

// Guild IDs of servers where we want to remove cEDH commands
const otherServers = [
  { id: '1428110749955260506', name: 'Tireless Golem (Pokemon TCG Pocket)' },
  { id: '1440900668746502189', name: 'Pokemon Pure Hackmons No Nerfs' }
];

(async () => {
  try {
    console.log('\n🧹 Cleaning up cEDH commands from other servers...\n');

    for (const server of otherServers) {
      console.log(`Clearing commands from: ${server.name}`);
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, server.id),
        { body: [] }
      );
      console.log(`✅ Cleared commands from ${server.name}\n`);
    }

    console.log('🎉 Cleanup complete! cEDH commands removed from Pokemon servers.');
    console.log('💡 The cEDH commands will now only appear in your cEDH server.\n');

  } catch (error) {
    console.error('❌ Error clearing commands:', error);
  }
})();
