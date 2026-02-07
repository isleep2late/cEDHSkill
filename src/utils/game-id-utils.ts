import { getDatabase } from '../db/init.js';
import crypto from 'crypto';
import { logger } from './logger.js';

export async function generateUniqueGameId(): Promise<string> {
  const db = getDatabase();
  let attempts = 0;
  const maxAttempts = 100; // Prevent infinite loops
  
  while (attempts < maxAttempts) {
    // Generate a random 6-character alphanumeric ID
    const gameId = crypto.randomBytes(3).toString('hex').toUpperCase();

    // ENHANCED: Ensure we never generate "0" as a game ID
if (gameId === '0' || gameId === '000000') {
  attempts++;
  continue;
}
    
    // Check if this ID already exists in either table
    const existsInMatches = await (await db.prepare('SELECT 1 FROM matches WHERE gameId = ? LIMIT 1')).get(gameId);
    const existsInDeckMatches = await (await db.prepare('SELECT 1 FROM deck_matches WHERE gameId = ? LIMIT 1')).get(gameId);
    const existsInGameIds = await (await db.prepare('SELECT 1 FROM game_ids WHERE gameId = ? LIMIT 1')).get(gameId);
    
    if (!existsInMatches && !existsInDeckMatches && !existsInGameIds) {
      return gameId;
    }
    
    attempts++;
  }
  
  // Fallback to UUID if we can't generate a unique short ID
  logger.warn('[GAME_ID] Failed to generate unique short ID, falling back to UUID');
  return crypto.randomUUID().substring(0, 8).toUpperCase();
}

export async function recordGameId(gameId: string, gameType: 'player' | 'deck'): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare('INSERT OR IGNORE INTO game_ids (gameId, gameType) VALUES (?, ?)');
  await stmt.run(gameId, gameType);
}

export async function getGameType(gameId: string): Promise<'player' | 'deck' | null> {
  const db = getDatabase();
  
  // First check the game_ids table
  const gameIdRecord = await (await db.prepare('SELECT gameType FROM game_ids WHERE gameId = ?')).get(gameId);
  if (gameIdRecord) {
    return (gameIdRecord as any).gameType;
  }
  
  // Fallback: check if it exists in matches or deck_matches
  const existsInMatches = await (await db.prepare('SELECT 1 FROM matches WHERE gameId = ? LIMIT 1')).get(gameId);
  if (existsInMatches) return 'player';
  
  const existsInDeckMatches = await (await db.prepare('SELECT 1 FROM deck_matches WHERE gameId = ? LIMIT 1')).get(gameId);
  if (existsInDeckMatches) return 'deck';
  
  return null;
}