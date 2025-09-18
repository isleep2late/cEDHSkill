import 'dotenv/config';
import { initDatabase } from './db/init.js';

async function startBot() {
  console.log('[Loader] Starting up...');
  
  try {
    await initDatabase();
    console.log('[Loader] Database initialized successfully');
    
    // Now start the bot AFTER DB is ready
    await import('./bot.js');
  } catch (error) {
    console.error('[Loader] Failed to start:', error);
    process.exit(1);
  }
}

startBot();