import { getDatabase } from './init.js';

export interface CleanupResult {
  cleanedPlayers: number;
  cleanedDecks: number;
}

/**
 * Remove players who have never participated in any games from the database
 */
export async function cleanupZeroPlayers(): Promise<{ cleanedPlayers: number }> {
  const db = getDatabase();
  
  try {
    // Find players who have no match records (never participated in games)
    const playersWithoutGames = await db.all(`
      SELECT userId FROM players 
      WHERE userId NOT IN (
        SELECT DISTINCT userId FROM matches
      )
    `);
    
    if (playersWithoutGames.length === 0) {
      return { cleanedPlayers: 0 };
    }
    
    console.log(`[CLEANUP] Found ${playersWithoutGames.length} players who never participated in games`);
    
    // Remove from all related tables
    for (const player of playersWithoutGames) {
      // Remove player deck assignments
      await db.run('DELETE FROM player_deck_assignments WHERE userId = ?', player.userId);
      
      // Remove from restricted list if present
      await db.run('DELETE FROM restricted WHERE userId = ?', player.userId);
      
      // Remove from suspicion exempt list if present
      await db.run('DELETE FROM suspicionExempt WHERE userId = ?', player.userId);
      
      // Remove from admin opt-in list if present
      await db.run('DELETE FROM adminOptIn WHERE userId = ?', player.userId);
      
      // Finally remove the player record
      await db.run('DELETE FROM players WHERE userId = ?', player.userId);
    }
    
    console.log(`[CLEANUP] Successfully removed ${playersWithoutGames.length} players who never participated in games`);
    return { cleanedPlayers: playersWithoutGames.length };
    
  } catch (error) {
    console.error('[CLEANUP] Error removing players without games:', error);
    throw error;
  }
}

/**
 * Remove decks that have never been played in any games from the database
 */
export async function cleanupZeroDecks(): Promise<{ cleanedDecks: number }> {
  const db = getDatabase();
  
  try {
    // Find decks that have no match records (never been played)
    const decksWithoutGames = await db.all(`
      SELECT normalizedName FROM decks 
      WHERE normalizedName NOT IN (
        SELECT DISTINCT deckNormalizedName FROM deck_matches
      )
    `);
    
    if (decksWithoutGames.length === 0) {
      return { cleanedDecks: 0 };
    }
    
    console.log(`[CLEANUP] Found ${decksWithoutGames.length} decks that were never played`);
    
    // Remove from all related tables
    for (const deck of decksWithoutGames) {
      // Remove player deck assignments for this deck
      await db.run('DELETE FROM player_deck_assignments WHERE deckNormalizedName = ?', deck.normalizedName);
      
      // Remove from player default decks
      await db.run('UPDATE players SET defaultDeck = NULL WHERE defaultDeck = ?', deck.normalizedName);
      
      // Remove from match assigned decks
      await db.run('UPDATE matches SET assignedDeck = NULL WHERE assignedDeck = ?', deck.normalizedName);
      
      // Finally remove the deck record
      await db.run('DELETE FROM decks WHERE normalizedName = ?', deck.normalizedName);
    }
    
    console.log(`[CLEANUP] Successfully removed ${decksWithoutGames.length} decks that were never played`);
    return { cleanedDecks: decksWithoutGames.length };
    
  } catch (error) {
    console.error('[CLEANUP] Error removing decks without games:', error);
    throw error;
  }
}

/**
 * Combined cleanup function for both players and decks
 */
export async function cleanupZeroRecords(): Promise<CleanupResult> {
  const playerResult = await cleanupZeroPlayers();
  const deckResult = await cleanupZeroDecks();
  
  return {
    cleanedPlayers: playerResult.cleanedPlayers,
    cleanedDecks: deckResult.cleanedDecks
  };
}

/**
 * Check if a player exists and has actually participated in games
 */
export async function playerExistsWithGames(userId: string): Promise<boolean> {
  const db = getDatabase();
  
  // Check if player exists in database
  const player = await db.get(`
    SELECT userId FROM players 
    WHERE userId = ?
  `, userId);
  
  if (!player) return false;
  
  // Check if player has actual match records (participated in games)
  const hasMatches = await db.get(`
    SELECT 1 FROM matches 
    WHERE userId = ? 
    LIMIT 1
  `, userId);
  
  return !!hasMatches;
}

/**
 * Check if a deck exists and has actually been played in games
 */
export async function deckExistsWithGames(normalizedName: string): Promise<boolean> {
  const db = getDatabase();
  
  // Check if deck exists in database
  const deck = await db.get(`
    SELECT normalizedName FROM decks 
    WHERE normalizedName = ?
  `, normalizedName);
  
  if (!deck) return false;
  
  // Check if deck has actual match records (been played in games)
  const hasMatches = await db.get(`
    SELECT 1 FROM deck_matches 
    WHERE deckNormalizedName = ? 
    LIMIT 1
  `, normalizedName);
  
  return !!hasMatches;
}

/**
 * Get game type from game ID
 */
export async function getGameType(gameId: string): Promise<'player' | 'deck' | null> {
  const db = getDatabase();
  
  // First check the game_ids table
  const gameIdRecord = await db.get('SELECT gameType FROM game_ids WHERE gameId = ?', gameId);
  if (gameIdRecord) {
    return gameIdRecord.gameType;
  }
  
  // Fallback: check if it exists in matches or deck_matches
  const existsInMatches = await db.get('SELECT 1 FROM matches WHERE gameId = ? LIMIT 1', gameId);
  if (existsInMatches) return 'player';
  
  const existsInDeckMatches = await db.get('SELECT 1 FROM deck_matches WHERE gameId = ? LIMIT 1', gameId);
  if (existsInDeckMatches) return 'deck';
  
  return null;
}

/**
 * Get matches by game ID
 */
export async function getMatchesByGameId(gameId: string): Promise<any[]> {
  const db = getDatabase();
  return await db.all('SELECT * FROM matches WHERE gameId = ? ORDER BY matchDate DESC', gameId);
}

/**
 * Get deck matches by game ID
 */
export async function getDeckMatchesByGameId(gameId: string): Promise<any[]> {
  const db = getDatabase();
  return await db.all('SELECT * FROM deck_matches WHERE gameId = ? ORDER BY matchDate DESC', gameId);
}
