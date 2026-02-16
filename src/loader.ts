import 'dotenv/config';
import { initDatabase } from './db/init.js';
import { logger } from './utils/logger.js';

async function startBot() {
  logger.info('[Loader] Starting up...');

  try {
    await initDatabase();
    logger.info('[Loader] Database initialized successfully');

    // Now start the bot AFTER DB is ready
    const { main } = await import('./bot.js');
    await main();
  } catch (error) {
    logger.error('[Loader] Failed to start:', error);
    process.exit(1);
  }
}

startBot();