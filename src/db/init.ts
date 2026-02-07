import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

let db: Database;

// Ensure data directory exists
const dataDir = path.resolve('data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Use consistent database name
const dbPath = path.resolve('data', 'cEDHSkill.db');
logger.info(`[DB] Using database file at: ${dbPath}`);

// Export database instance for other modules
export function getDatabase() {
  return db;
}

export async function initDatabase() {
  logger.info('[DB] Initializing database...');

  // Open database connection
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys and WAL mode for better performance
  await db.exec('PRAGMA foreign_keys = ON');
  await db.exec('PRAGMA journal_mode = WAL');

  logger.info('[DB] Initializing tables...');

  // Players table with default deck support
  await db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      userId TEXT PRIMARY KEY,
      mu REAL NOT NULL DEFAULT 25.0,
      sigma REAL NOT NULL DEFAULT 8.333,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      gamesPlayed INTEGER DEFAULT 0,
      lastPlayed TEXT,
      defaultDeck TEXT
    )
  `);

  // Matches table with turn order support, gameId, gameSequence, and assigned deck
  await db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT,
      gameId TEXT,
      userId TEXT,
      status TEXT,
      matchDate TEXT,
      mu REAL,
      sigma REAL,
      teams TEXT,
      scores TEXT,
      score REAL,
      submittedByAdmin INTEGER DEFAULT 0,
      turnOrder INTEGER,
      gameSequence REAL,
      assignedDeck TEXT
    )
  `);

  // Restricted players table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS restricted (
      userId TEXT PRIMARY KEY
    )
  `);

  // Admin preferences table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS adminOptIn (
      userId TEXT PRIMARY KEY,
      optIn INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Suspicion exemption table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS suspicionExempt (
      userId TEXT PRIMARY KEY
    )
  `);

  // Decks table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS decks (
      normalizedName TEXT PRIMARY KEY,
      displayName TEXT NOT NULL,
      mu REAL DEFAULT 25.0,
      sigma REAL DEFAULT 8.333,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Deck matches table with gameId, gameSequence, and assigned player
  await db.exec(`
    CREATE TABLE IF NOT EXISTS deck_matches (
      id TEXT,
      gameId TEXT,
      deckNormalizedName TEXT NOT NULL,
      deckDisplayName TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('w', 'l', 'd')),
      matchDate TEXT NOT NULL,
      mu REAL NOT NULL,
      sigma REAL NOT NULL,
      turnOrder INTEGER,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      gameSequence REAL,
      submittedByAdmin INTEGER DEFAULT 0,
      assignedPlayer TEXT
    )
  `);

  // Player deck assignments table for tracking which deck each player used in each game
  await db.exec(`
    CREATE TABLE IF NOT EXISTS player_deck_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      gameId TEXT,
      deckNormalizedName TEXT NOT NULL,
      deckDisplayName TEXT NOT NULL,
      assignmentType TEXT NOT NULL CHECK (assignmentType IN ('default', 'game_specific', 'all_games')),
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      createdBy TEXT,
      UNIQUE(userId, gameId)
    )
  `);

  // Game IDs tracking table with gameSequence and status
  await db.exec(`
    CREATE TABLE IF NOT EXISTS game_ids (
      gameId TEXT PRIMARY KEY,
      gameType TEXT NOT NULL CHECK (gameType IN ('player', 'deck')),
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      gameSequence REAL,
      status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'undone'))
    )
  `);

  // Games master table for chronological ordering with admin tracking
  await db.exec(`
    CREATE TABLE IF NOT EXISTS games_master (
      gameId TEXT PRIMARY KEY,
      gameSequence REAL NOT NULL,
      gameType TEXT NOT NULL CHECK (gameType IN ('player', 'deck')),
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      submittedBy TEXT,
      submittedByAdmin INTEGER DEFAULT 0,
      status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'undone'))
    )
  `);

  // Rating changes audit table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS rating_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      targetType TEXT NOT NULL CHECK (targetType IN ('player', 'deck')),
      targetId TEXT NOT NULL,
      targetDisplayName TEXT NOT NULL,
      changeType TEXT NOT NULL CHECK (changeType IN ('manual', 'game', 'decay', 'wld_adjustment', 'undo', 'redo')),
      adminUserId TEXT,
      oldMu REAL NOT NULL,
      oldSigma REAL NOT NULL,
      oldElo INTEGER NOT NULL,
      newMu REAL NOT NULL,
      newSigma REAL NOT NULL, 
      newElo INTEGER NOT NULL,
      parameters TEXT,
      reason TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      oldWins INTEGER,
      oldLosses INTEGER,
      oldDraws INTEGER,
      newWins INTEGER,
      newLosses INTEGER,
      newDraws INTEGER
    )
  `);

  // Enhanced undo system table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS undoable_operations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('game', 'set_command')),
      timestamp TEXT NOT NULL,
      adminUserId TEXT NOT NULL,
      description TEXT NOT NULL,
      data TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'undone')),
      undoneAt TEXT
    )
  `);

  // Create indexes for performance
  logger.info('[DB] Creating indexes...');
  
  // Player and match indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_user_date ON matches(userId, matchDate)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_turn_order ON matches(turnOrder)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_game_id ON matches(gameId)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_game_sequence ON matches(gameSequence)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_submitted_by_admin ON matches(submittedByAdmin)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_assigned_deck ON matches(assignedDeck)`);
  
  // Deck and deck match indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_deck_matches_deck ON deck_matches(deckNormalizedName)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_deck_matches_date ON deck_matches(matchDate)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_deck_matches_turn_order ON deck_matches(turnOrder)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_deck_matches_game_id ON deck_matches(gameId)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_deck_matches_game_sequence ON deck_matches(gameSequence)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_deck_matches_submitted_by_admin ON deck_matches(submittedByAdmin)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_deck_matches_assigned_player ON deck_matches(assignedPlayer)`);
  
  // Games master indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_games_master_sequence ON games_master(gameSequence)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_games_master_type ON games_master(gameType)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_games_master_status ON games_master(status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_games_master_submitted_by_admin ON games_master(submittedByAdmin)`);
  
  // Rating changes audit indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_rating_changes_target ON rating_changes(targetType, targetId)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_rating_changes_admin ON rating_changes(adminUserId)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_rating_changes_timestamp ON rating_changes(timestamp)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_rating_changes_type ON rating_changes(changeType)`);

  // Player deck assignment indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_player_deck_assignments_user ON player_deck_assignments(userId)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_player_deck_assignments_game ON player_deck_assignments(gameId)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_player_deck_assignments_deck ON player_deck_assignments(deckNormalizedName)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_player_deck_assignments_type ON player_deck_assignments(assignmentType)`);

  // Enhanced undo system indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_undoable_operations_timestamp ON undoable_operations(timestamp)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_undoable_operations_status ON undoable_operations(status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_undoable_operations_admin ON undoable_operations(adminUserId)`);

  // Add missing columns to existing tables if they don't exist
  logger.info('[DB] Checking for missing columns...');
  
  try {
    await db.exec(`ALTER TABLE matches ADD COLUMN gameId TEXT`);
    logger.info('[DB] Added gameId column to matches table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE matches ADD COLUMN gameSequence REAL`);
    logger.info('[DB] Added gameSequence column to matches table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE matches ADD COLUMN assignedDeck TEXT`);
    logger.info('[DB] Added assignedDeck column to matches table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE players ADD COLUMN defaultDeck TEXT`);
    logger.info('[DB] Added defaultDeck column to players table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE deck_matches ADD COLUMN gameId TEXT`);
    logger.info('[DB] Added gameId column to deck_matches table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE deck_matches ADD COLUMN gameSequence REAL`);
    logger.info('[DB] Added gameSequence column to deck_matches table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE deck_matches ADD COLUMN submittedByAdmin INTEGER DEFAULT 0`);
    logger.info('[DB] Added submittedByAdmin column to deck_matches table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE deck_matches ADD COLUMN assignedPlayer TEXT`);
    logger.info('[DB] Added assignedPlayer column to deck_matches table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE game_ids ADD COLUMN gameSequence REAL`);
    logger.info('[DB] Added gameSequence column to game_ids table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE game_ids ADD COLUMN status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'undone'))`);
    logger.info('[DB] Added status column to game_ids table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE games_master ADD COLUMN submittedByAdmin INTEGER DEFAULT 0`);
    logger.info('[DB] Added submittedByAdmin column to games_master table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE rating_changes ADD COLUMN oldWins INTEGER`);
    logger.info('[DB] Added oldWins column to rating_changes table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE rating_changes ADD COLUMN oldLosses INTEGER`);
    logger.info('[DB] Added oldLosses column to rating_changes table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE rating_changes ADD COLUMN oldDraws INTEGER`);
    logger.info('[DB] Added oldDraws column to rating_changes table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE rating_changes ADD COLUMN newWins INTEGER`);
    logger.info('[DB] Added newWins column to rating_changes table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE rating_changes ADD COLUMN newLosses INTEGER`);
    logger.info('[DB] Added newLosses column to rating_changes table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE rating_changes ADD COLUMN newDraws INTEGER`);
    logger.info('[DB] Added newDraws column to rating_changes table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE games_master ADD COLUMN active INTEGER DEFAULT 1`);
    logger.info('[DB] Added active column to games_master table');
  } catch (error) {
    // Column already exists, ignore
  }

  try {
    await db.exec(`ALTER TABLE game_ids ADD COLUMN active INTEGER DEFAULT 1`);
    logger.info('[DB] Added active column to game_ids table');
  } catch (error) {
    // Column already exists, ignore
  }

  // Add index for active field for performance
  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_games_master_active ON games_master(active)`);
    logger.info('[DB] Added active index to games_master table');
  } catch (error) {
    // Index already exists, ignore
  }

  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_ids_active ON game_ids(active)`);
    logger.info('[DB] Added active index to game_ids table');
  } catch (error) {
    // Index already exists, ignore
  }

  // Migration: Update rating_changes CHECK constraint to include 'redo'
  // SQLite doesn't support ALTER TABLE for CHECK constraints, so we need to recreate the table
  try {
    // Check if we need to migrate (try inserting a 'redo' type - if it fails, we need to migrate)
    const testResult = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='rating_changes'`);
    if (testResult?.sql && !testResult.sql.includes("'redo'")) {
      logger.info('[DB] Migrating rating_changes table to support redo changeType...');

      await db.exec(`BEGIN TRANSACTION`);

      // Create new table with updated constraint
      await db.exec(`
        CREATE TABLE rating_changes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          targetType TEXT NOT NULL CHECK (targetType IN ('player', 'deck')),
          targetId TEXT NOT NULL,
          targetDisplayName TEXT NOT NULL,
          changeType TEXT NOT NULL CHECK (changeType IN ('manual', 'game', 'decay', 'wld_adjustment', 'undo', 'redo')),
          adminUserId TEXT,
          oldMu REAL NOT NULL,
          oldSigma REAL NOT NULL,
          oldElo INTEGER NOT NULL,
          newMu REAL NOT NULL,
          newSigma REAL NOT NULL,
          newElo INTEGER NOT NULL,
          parameters TEXT,
          reason TEXT,
          timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
          oldWins INTEGER,
          oldLosses INTEGER,
          oldDraws INTEGER,
          newWins INTEGER,
          newLosses INTEGER,
          newDraws INTEGER
        )
      `);

      // Copy data from old table
      await db.exec(`
        INSERT INTO rating_changes_new
        SELECT * FROM rating_changes
      `);

      // Drop old table and rename new one
      await db.exec(`DROP TABLE rating_changes`);
      await db.exec(`ALTER TABLE rating_changes_new RENAME TO rating_changes`);

      await db.exec(`COMMIT`);
      logger.info('[DB] Successfully migrated rating_changes table');
    }
  } catch (error) {
    logger.info('[DB] rating_changes migration not needed or already complete');
    try {
      await db.exec(`ROLLBACK`);
    } catch {
      // No transaction to rollback
    }
  }

  logger.info('[DB] All tables and indexes initialized successfully');
}