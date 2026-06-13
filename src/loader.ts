import 'dotenv/config';
import { initDatabase, closeDatabase } from './db/init.js';
import { logger } from './utils/logger.js';

// Checkpoint the WAL into the main DB on a clean stop so a future crash can't
// strand un-checkpointed writes (the cause of the original outage). Guarded so
// two signals (or a signal during an error exit) don't double-run it.
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Loader] Received ${signal}, shutting down cleanly...`);
  await closeDatabase();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void gracefulShutdown(signal); });
}

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