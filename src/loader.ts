// src/loader.ts
import { initDatabase } from './db/init.js';

console.log('[Loader] Starting up...');
await initDatabase();

// Now start the bot AFTER DB is ready
await import('./bot.js');
