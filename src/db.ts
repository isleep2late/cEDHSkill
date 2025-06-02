import { createRequire } from 'node:module';
import { Sequelize } from 'sequelize';

import { definePlayerRatingModel } from './models/db/player-rating.js';
import { Logger } from './services/index.js';

const require = createRequire(import.meta.url);
let Config = require('../config/config.json');

const sequelize = new Sequelize(
    Config.database.name,
    Config.database.user,
    Config.database.password,
    {
        host: Config.database.host,
        dialect: Config.database.dialect,
        logging: Config.database.logging ? msg => Logger.info(msg) : false,
        storage: Config.database.storagePath,
    }
);

const PlayerRating = definePlayerRatingModel(sequelize);

async function initializeDatabase(): Promise<void> {
    try {
        await sequelize.sync();
        Logger.info('Database tables synced successfully.');
    } catch (error) {
        Logger.error('Error syncing database tables:', error);
        process.exit(1); // Exit if DB sync fails, as it's likely critical
    }
}

export { sequelize, PlayerRating, initializeDatabase };
