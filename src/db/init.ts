import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';

// Ensure the 'data' directory exists before SQLite tries to write to it
const dataDir = path.resolve('data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Log to confirm the path where the DB is being created
console.log(`[DB] Using database file at: ${path.resolve('data', 'database.sqlite')}`);

export const dbPromise = open({
    filename: path.resolve('data', 'database.sqlite'),
    driver: sqlite3.Database,
});

export async function initDatabase() {
    const db = await dbPromise;

    console.log('[DB] Initializing tables...');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS players (
            userId TEXT PRIMARY KEY,
            mu REAL NOT NULL,
            sigma REAL NOT NULL,
            wins INTEGER DEFAULT 0,
            losses INTEGER DEFAULT 0,
            draws INTEGER DEFAULT 0,
            gamesPlayed INTEGER DEFAULT 0,
            lastPlayed TEXT
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS matches (
            id TEXT,
            userId TEXT,
            status TEXT,
            timestamp TEXT,
            mu REAL,
            sigma REAL,
            allies TEXT,
            enemies TEXT,
            score REAL,
            submittedByAdmin BOOLEAN DEFAULT 0
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS restricted (
            userId TEXT PRIMARY KEY
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS admin_prefs (
            userId TEXT PRIMARY KEY,
            receiveAlerts INTEGER
        );
    `);

    console.log('[DB] All tables initialized');
}
