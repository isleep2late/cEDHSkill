import { getDatabase } from '../db/init.js';
import { normalizeCommanderName, validateCommander } from './edhrec-utils.js';

export interface PlayerDeckAssignment {
  id: number;
  userId: string;
  gameId: string | null;
  deckNormalizedName: string;
  deckDisplayName: string;
  assignmentType: 'default' | 'game_specific' | 'all_games';
  createdAt: string;
  createdBy: string;
}

/**
 * Get the deck assigned to a player for a specific game
 */
export async function getPlayerDeckForGame(userId: string, gameId: string): Promise<string | null> {
  const db = getDatabase();
  
  // First check for game-specific assignment
  const gameSpecific = await db.get(`
    SELECT deckNormalizedName 
    FROM player_deck_assignments 
    WHERE userId = ? AND gameId = ? AND assignmentType = 'game_specific'
  `, userId, gameId);
  
  if (gameSpecific) {
    return gameSpecific.deckNormalizedName;
  }
  
  // Then check for default deck
  const defaultDeck = await db.get(`
    SELECT defaultDeck 
    FROM players 
    WHERE userId = ? AND defaultDeck IS NOT NULL
  `, userId);
  
  return defaultDeck?.defaultDeck || null;
}

/**
 * Get all deck assignments for a player
 */
export async function getPlayerDeckAssignments(userId: string): Promise<PlayerDeckAssignment[]> {
  const db = getDatabase();
  return await db.all(`
    SELECT * 
    FROM player_deck_assignments 
    WHERE userId = ? 
    ORDER BY createdAt DESC
  `, userId);
}

/**
 * Get all players assigned to a specific deck
 */
export async function getPlayersForDeck(deckNormalizedName: string): Promise<{
  defaultUsers: string[];
  gameSpecificAssignments: { userId: string; gameId: string; createdAt: string }[];
}> {
  const db = getDatabase();
  
  // Get players with this as default deck
  const defaultUsers = await db.all(`
    SELECT userId 
    FROM players 
    WHERE defaultDeck = ?
  `, deckNormalizedName);
  
  // Get game-specific assignments
  const gameSpecificAssignments = await db.all(`
    SELECT userId, gameId, createdAt 
    FROM player_deck_assignments 
    WHERE deckNormalizedName = ? AND assignmentType = 'game_specific'
    ORDER BY createdAt DESC
  `, deckNormalizedName);
  
  return {
    defaultUsers: defaultUsers.map(u => u.userId),
    gameSpecificAssignments
  };
}

/**
 * Assign a deck to a player
 */
export async function assignDeckToPlayer(
  userId: string,
  deckName: string,
  assignmentType: 'default' | 'game_specific' | 'all_games',
  createdBy: string,
  gameId?: string
): Promise<void> {
  const db = getDatabase();
  
  // Validate commander name against EDHREC first
  try {
    if (!await validateCommander(deckName)) {
      throw new Error(`"${deckName}" is not a valid commander name according to EDHREC.`);
    }
  } catch (error) {
    console.error('Error validating commander for assignment:', error);
    throw new Error(`Unable to validate commander "${deckName}". Please check the name and try again.`);
  }

  const normalizedName = normalizeCommanderName(deckName);
  
  if (assignmentType === 'default') {
    // Update player's default deck
    await db.run(`
      UPDATE players 
      SET defaultDeck = ? 
      WHERE userId = ?
    `, normalizedName, userId);
    
  } else if (assignmentType === 'game_specific' && gameId) {
    // Add game-specific assignment
    await db.run(`
      INSERT OR REPLACE INTO player_deck_assignments 
      (userId, gameId, deckNormalizedName, deckDisplayName, assignmentType, createdBy)
      VALUES (?, ?, ?, ?, ?, ?)
    `, userId, gameId, normalizedName, deckName, assignmentType, createdBy);
    
  } else if (assignmentType === 'all_games') {
    // Set as default and update all existing matches
    await db.run(`
      UPDATE players 
      SET defaultDeck = ? 
      WHERE userId = ?
    `, normalizedName, userId);
    
    // Update all existing player matches
    await db.run(`
      UPDATE matches 
      SET assignedDeck = ? 
      WHERE userId = ?
    `, normalizedName, userId);
    
    // Update all existing deck matches to show this player
    await db.run(`
      UPDATE deck_matches 
      SET assignedPlayer = ? 
      WHERE deckNormalizedName = ?
    `, userId, normalizedName);
  }
}

/**
 * Remove deck assignment from a player
 */
export async function removeDeckFromPlayer(
  userId: string,
  assignmentType: 'default' | 'game_specific' | 'all_games',
  gameId?: string
): Promise<void> {
  const db = getDatabase();
  
  if (assignmentType === 'default') {
    // Remove default deck
    await db.run(`
      UPDATE players 
      SET defaultDeck = NULL 
      WHERE userId = ?
    `, userId);
    
  } else if (assignmentType === 'game_specific' && gameId) {
    // Remove game-specific assignment
    await db.run(`
      DELETE FROM player_deck_assignments 
      WHERE userId = ? AND gameId = ?
    `, userId, gameId);
    
  } else if (assignmentType === 'all_games') {
    // Remove all assignments
    await db.run(`
      DELETE FROM player_deck_assignments 
      WHERE userId = ?
    `, userId);
    
    await db.run(`
      UPDATE players 
      SET defaultDeck = NULL 
      WHERE userId = ?
    `, userId);
    
    // Remove from all matches
    await db.run(`
      UPDATE matches 
      SET assignedDeck = NULL 
      WHERE userId = ?
    `, userId);
    
    await db.run(`
      UPDATE deck_matches 
      SET assignedPlayer = NULL 
      WHERE assignedPlayer = ?
    `, userId);
  }
}

/**
 * Update match records with deck assignments
 */
export async function updateMatchWithDeckAssignment(
  gameId: string,
  userId: string,
  deckNormalizedName: string
): Promise<void> {
  const db = getDatabase();
  
  // Update player match record
  await db.run(`
    UPDATE matches 
    SET assignedDeck = ? 
    WHERE gameId = ? AND userId = ?
  `, deckNormalizedName, gameId, userId);
  
  // Update deck match record if it exists
  await db.run(`
    UPDATE deck_matches 
    SET assignedPlayer = ? 
    WHERE gameId = ? AND deckNormalizedName = ?
  `, userId, gameId, deckNormalizedName);
}

/**
 * Get statistics for player-deck combinations
 */
export async function getPlayerDeckStats(userId: string, deckNormalizedName: string): Promise<{
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}> {
  const db = getDatabase();
  
  const stats = await db.get(`
    SELECT 
      COUNT(*) as totalGames,
      SUM(CASE WHEN status = 'w' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'l' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN status = 'd' THEN 1 ELSE 0 END) as draws
    FROM matches 
    WHERE userId = ? AND assignedDeck = ?
  `, userId, deckNormalizedName);
  
  const winRate = stats.totalGames > 0 ? (stats.wins / stats.totalGames) * 100 : 0;
  
  return {
    totalGames: stats.totalGames,
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.draws,
    winRate: Math.round(winRate * 10) / 10
  };
}

/**
 * Get top performing player-deck combinations
 */
export async function getTopPlayerDeckCombinations(limit: number = 10): Promise<Array<{
  userId: string;
  deckNormalizedName: string;
  deckDisplayName: string;
  totalGames: number;
  wins: number;
  winRate: number;
}>> {
  const db = getDatabase();
  
  return await db.all(`
    SELECT 
      m.userId,
      m.assignedDeck as deckNormalizedName,
      d.displayName as deckDisplayName,
      COUNT(*) as totalGames,
      SUM(CASE WHEN m.status = 'w' THEN 1 ELSE 0 END) as wins,
      ROUND(
        (CAST(SUM(CASE WHEN m.status = 'w' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) * 100, 
        1
      ) as winRate
    FROM matches m
    JOIN decks d ON m.assignedDeck = d.normalizedName
    WHERE m.assignedDeck IS NOT NULL
    GROUP BY m.userId, m.assignedDeck
    HAVING COUNT(*) >= 3
    ORDER BY winRate DESC, totalGames DESC
    LIMIT ?
  `, limit);
}

/**
 * Migrate existing data to support deck assignments
 */
export async function migrateExistingDataForDeckAssignments(): Promise<void> {
  const db = getDatabase();
  console.log('[MIGRATION] Starting deck assignment migration...');
  
  try {
    // Find matches that have deck information but no assignments
    const matchesWithDecks = await db.all(`
      SELECT DISTINCT userId, assignedDeck
      FROM matches 
      WHERE assignedDeck IS NOT NULL 
      AND userId NOT IN (
        SELECT userId FROM players WHERE defaultDeck IS NOT NULL
      )
    `);
    
    // Set most commonly used deck as default for each player
    for (const match of matchesWithDecks) {
      const mostUsedDeck = await db.get(`
        SELECT assignedDeck, COUNT(*) as count
        FROM matches 
        WHERE userId = ? AND assignedDeck IS NOT NULL
        GROUP BY assignedDeck
        ORDER BY count DESC
        LIMIT 1
      `, match.userId);
      
      if (mostUsedDeck) {
        await db.run(`
          UPDATE players 
          SET defaultDeck = ? 
          WHERE userId = ?
        `, mostUsedDeck.assignedDeck, match.userId);
        
        console.log(`[MIGRATION] Set ${mostUsedDeck.assignedDeck} as default for user ${match.userId}`);
      }
    }
    
    console.log('[MIGRATION] Deck assignment migration completed successfully');
    
  } catch (error) {
    console.error('[MIGRATION] Error during deck assignment migration:', error);
    throw error;
  }
}
