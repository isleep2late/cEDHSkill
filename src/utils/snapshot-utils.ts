import { calculateElo } from './elo-utils.js';
import { logger } from './logger.js';

export interface PlayerSnapshot {
  userId: string;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
  draws: number;
  tag: string;
  turnOrder?: number;
  commander?: string;
  lastPlayed?: string | null;
}

export interface DeckSnapshot {
  normalizedName: string;
  displayName: string;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
  draws: number;
  turnOrder?: number;
}

export interface MatchSnapshot {
  matchId: string;
  gameId: string;
  gameSequence: number;
  gameType: 'player' | 'deck';
  matchData: any[];
  before: (PlayerSnapshot | DeckSnapshot)[];
  after: (PlayerSnapshot | DeckSnapshot)[];
  timestamp?: string;
  description?: string;
}

export interface SetCommandSnapshot {
  matchId: string; // Use unique ID like "set-{timestamp}"
  gameId: string;  // Use "manual" or similar
  gameSequence: number; // Use timestamp or increment
  gameType: 'set_command';
  operationType: 'rating_change' | 'deck_assignment' | 'turn_order' | 'game_modification' | 'turn_order_removal' | 'bulk_turn_order_removal';
  targetType: 'player' | 'deck' | 'game';
  targetId: string;
  before: {
    // For rating changes
    mu?: number;
    sigma?: number;
    wins?: number;
    losses?: number;
    draws?: number;

    // For deck assignments
    defaultDeck?: string | null;
    gameSpecificDeck?: string | null;

    // For turn order
    turnOrder?: number | null;
    gamesWithTurnOrder?: string[];

    // For game modifications
    active?: boolean;
    matchRecords?: any[];
    deckMatchRecords?: any[];

    // For deck assignments (bulk/allgames)
    matchAssignments?: Array<{ gameId: string; assignedDeck: string | null }>;
    playerDeckAssignments?: any[];
    needsRecalculation?: boolean;

  };
  after: {
    mu?: number;
    sigma?: number;
    wins?: number;
    losses?: number;
    draws?: number;
    defaultDeck?: string | null;
    gameSpecificDeck?: string | null;
    turnOrder?: number | null;
    gamesWithTurnOrder?: string[];
    active?: boolean;
    matchRecords?: any[];
    deckMatchRecords?: any[];
    matchAssignments?: Array<{ gameId: string; assignedDeck: string | null }>;
    playerDeckAssignments?: any[];
    needsRecalculation?: boolean;
  };
  metadata: {
    adminUserId: string;
    parameters: string; // JSON string of original command parameters
    reason: string;
  };
  timestamp: string;
  description: string;
}

// Decay snapshot for undoable decay operations
export interface DecayPlayerState {
  userId: string;
  beforeMu: number;
  beforeSigma: number;
  afterMu: number;
  afterSigma: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface DecaySnapshot {
  matchId: string; // Use unique ID like "decay-{timestamp}"
  gameId: string;  // Use "decay" as identifier
  gameSequence: number;
  gameType: 'decay';
  players: DecayPlayerState[];
  metadata: {
    graceDays: number;
    eloCutoff: number;
    decayAmount: number;
    triggeredBy: 'cron' | 'timewalk';
    adminUserId?: string;
    simulatedDaysOffset?: number; // For timewalk: how many extra days were simulated
  };
  timestamp: string;
  description: string;
}

// Union type for all snapshot types
export type UniversalSnapshot = MatchSnapshot | SetCommandSnapshot | DecaySnapshot;

// Main stacks for undo/redo functionality
const MAX_STACK_SIZE = 100; // Prevent unbounded memory growth
const rankOpHistoryStack: UniversalSnapshot[] = [];
const undoneStack: UniversalSnapshot[] = [];

// Stack management functions
export function saveMatchSnapshot(snapshot: MatchSnapshot): void {
  // Add timestamp and description if not present
  if (!snapshot.timestamp) {
    snapshot.timestamp = new Date().toISOString();
  }
  if (!snapshot.description) {
    // Simple description based on game type
    snapshot.description = `${snapshot.gameType} game ${snapshot.gameId}`;
  }

  rankOpHistoryStack.push(snapshot);

  // Trim oldest entries if stack exceeds max size
  if (rankOpHistoryStack.length > MAX_STACK_SIZE) {
    const removed = rankOpHistoryStack.splice(0, rankOpHistoryStack.length - MAX_STACK_SIZE);
    logger.info(`[SNAPSHOT] Trimmed ${removed.length} oldest entries from stack`);
  }

  // Clear redo stack when new operation is saved
  undoneStack.length = 0;

  logger.info(`[SNAPSHOT] Saved ${snapshot.description} to stack (${rankOpHistoryStack.length} total)`);
}

export function saveOperationSnapshot(snapshot: UniversalSnapshot): void {
  if (!snapshot.timestamp) {
    snapshot.timestamp = new Date().toISOString();
  }
  
  rankOpHistoryStack.push(snapshot);

  // Trim oldest entries if stack exceeds max size
  if (rankOpHistoryStack.length > MAX_STACK_SIZE) {
    const removed = rankOpHistoryStack.splice(0, rankOpHistoryStack.length - MAX_STACK_SIZE);
    logger.info(`[SNAPSHOT] Trimmed ${removed.length} oldest entries from stack`);
  }

  undoneStack.length = 0; // Clear redo stack

  logger.info(`[SNAPSHOT] Saved ${snapshot.gameType} operation to stack (${rankOpHistoryStack.length} total)`);
}

export function getStackInfo(): { active: number; undone: number } {
  return {
    active: rankOpHistoryStack.length,
    undone: undoneStack.length
  };
}

export function clearAllStacks(): void {
  rankOpHistoryStack.length = 0;
  undoneStack.length = 0;
  logger.info('[SNAPSHOT] Cleared all stacks');
}

// Unified undo/redo operations
export async function undoLastOperation(): Promise<UniversalSnapshot | null> {
  if (rankOpHistoryStack.length === 0) {
    logger.info('[SNAPSHOT] No operations to undo');
    return null;
  }

  const snapshot = rankOpHistoryStack.pop()!;

  if (snapshot.gameType === 'set_command') {
    await undoSetCommand(snapshot as SetCommandSnapshot);
  } else if (snapshot.gameType === 'decay') {
    await undoDecay(snapshot as DecaySnapshot);
  } else {
    await ensureCompleteGameMetadata(snapshot as MatchSnapshot);
    await removeGameFromDatabase(snapshot.gameId, snapshot.gameType);
  }

  undoneStack.push(snapshot);

  logger.info(`[SNAPSHOT] Undid operation: ${snapshot.gameType} (${rankOpHistoryStack.length} remaining, ${undoneStack.length} undone)`);
  return snapshot;
}

export async function redoLastOperation(): Promise<UniversalSnapshot | null> {
  if (undoneStack.length === 0) {
    logger.info('[SNAPSHOT] No operations to redo');
    return null;
  }

  const snapshot = undoneStack.pop()!;

  if (snapshot.gameType === 'set_command') {
    await redoSetCommand(snapshot as SetCommandSnapshot);
  } else if (snapshot.gameType === 'decay') {
    await redoDecay(snapshot as DecaySnapshot);
  }
  // Game restoration handled in redo command for match snapshots

  rankOpHistoryStack.push(snapshot);

  logger.info(`[SNAPSHOT] Redid operation: ${snapshot.gameType} (${rankOpHistoryStack.length} active, ${undoneStack.length} undone)`);
  return snapshot;
}

// Legacy functions for compatibility (now use unified system)
export async function undoLastMatch(): Promise<MatchSnapshot | null> {
  const snapshot = await undoLastOperation();
  return snapshot && snapshot.gameType !== 'set_command' ? snapshot as MatchSnapshot : null;
}

export async function redoLastMatch(): Promise<MatchSnapshot | null> {
  const snapshot = await redoLastOperation();
  return snapshot && snapshot.gameType !== 'set_command' ? snapshot as MatchSnapshot : null;
}

// Multiple operation undo (undo back to specific game)
export async function undoToSpecificGame(gameId: string): Promise<MatchSnapshot[]> {
  // Find the game in the snapshot stack
  const gameIndex = rankOpHistoryStack.findIndex(snapshot => snapshot.gameId === gameId);
  
  if (gameIndex === -1) {
    logger.info(`[SNAPSHOT] Game ${gameId} not found in active stack`);
    return [];
  }
  
  // Undo all games from the end of stack back to (and including) the specified game
  const undoneSnapshots: MatchSnapshot[] = [];
  
  // We need to undo in reverse order (latest first) to maintain consistency
  while (rankOpHistoryStack.length > gameIndex) {
    const snapshot = rankOpHistoryStack.pop()!;
    
    // Only process match snapshots for this legacy function
    if (snapshot.gameType !== 'set_command') {
      const matchSnapshot = snapshot as MatchSnapshot;
      // Ensure we have complete game metadata before database removal
      await ensureCompleteGameMetadata(matchSnapshot);
      
      undoneSnapshots.unshift(matchSnapshot); // Add to front to maintain chronological order
      await removeGameFromDatabase(matchSnapshot.gameId, matchSnapshot.gameType);
    }
    
    undoneStack.push(snapshot);
  }
  
  logger.info(`[SNAPSHOT] Undid ${undoneSnapshots.length} operations back to game ${gameId}`);
  return undoneSnapshots;
}

// Targeted undo functions for specific game types
export async function undoLastDeckMatch(): Promise<MatchSnapshot | null> {
  // Find last deck match (reverse search)
  for (let i = rankOpHistoryStack.length - 1; i >= 0; i--) {
    if (rankOpHistoryStack[i].gameType === 'deck') {
      const snapshot = rankOpHistoryStack.splice(i, 1)[0] as MatchSnapshot;
      
      // Ensure we have complete game metadata
      await ensureCompleteGameMetadata(snapshot);
      
      undoneStack.push(snapshot);
      await removeGameFromDatabase(snapshot.gameId, snapshot.gameType);
      
      logger.info(`[SNAPSHOT] Undid deck game ${snapshot.gameId} from position ${i}`);
      return snapshot;
    }
  }
  
  logger.info('[SNAPSHOT] No deck games found in stack to undo');
  return null;
}

export async function redoLastDeckMatch(): Promise<MatchSnapshot | null> {
  // Find last deck match in undone stack (reverse search)
  for (let i = undoneStack.length - 1; i >= 0; i--) {
    if (undoneStack[i].gameType === 'deck') {
      const snapshot = undoneStack.splice(i, 1)[0] as MatchSnapshot;
      rankOpHistoryStack.push(snapshot);
      
      logger.info(`[SNAPSHOT] Redid deck game ${snapshot.gameId} from undone stack position ${i}`);
      return snapshot;
    }
  }
  
  logger.info('[SNAPSHOT] No deck games found in undone stack to redo');
  return null;
}

// Set command undo/redo handlers
async function undoSetCommand(snapshot: SetCommandSnapshot): Promise<void> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();
  
  if (snapshot.targetType === 'player') {
    if (snapshot.operationType === 'rating_change') {
      const { updatePlayerRating } = await import('../db/player-utils.js');
      await updatePlayerRating(
        snapshot.targetId,
        snapshot.before.mu!,
        snapshot.before.sigma!,
        snapshot.before.wins!,
        snapshot.before.losses!,
        snapshot.before.draws!
      );
    } else if (snapshot.operationType === 'deck_assignment') {
      // Restore defaultDeck
      if (snapshot.before.defaultDeck !== undefined) {
        await db.run('UPDATE players SET defaultDeck = ? WHERE userId = ?',
          [snapshot.before.defaultDeck, snapshot.targetId]);
      }

      // Restore match assignedDeck values
      if (snapshot.before.matchAssignments) {
        for (const ma of snapshot.before.matchAssignments) {
          await db.run('UPDATE matches SET assignedDeck = ? WHERE userId = ? AND gameId = ?',
            [ma.assignedDeck, snapshot.targetId, ma.gameId]);
        }
      }

      // Restore player_deck_assignments
      if (snapshot.before.playerDeckAssignments !== undefined) {
        await db.run('DELETE FROM player_deck_assignments WHERE userId = ?', snapshot.targetId);
        for (const pda of snapshot.before.playerDeckAssignments) {
          await db.run(`
            INSERT INTO player_deck_assignments (userId, gameId, deckNormalizedName, deckDisplayName, assignmentType, createdBy)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [pda.userId, pda.gameId, pda.deckNormalizedName, pda.deckDisplayName, pda.assignmentType, pda.createdBy]);
        }
      }

      // Recalculate if the original operation triggered recalculation
      if (snapshot.before.needsRecalculation) {
        const { recalculateAllPlayersFromScratch, recalculateAllDecksFromScratch } = await import('../commands/set.js');
        logger.info(`[SNAPSHOT] Recalculating all ratings after undoing deck assignment...`);
        await recalculateAllPlayersFromScratch();
        await recalculateAllDecksFromScratch();
        const { cleanupZeroPlayers, cleanupZeroDecks } = await import('../db/database-utils.js');
        await cleanupZeroPlayers();
        await cleanupZeroDecks();
      }
    } else if (snapshot.operationType === 'turn_order' || snapshot.operationType === 'turn_order_removal') {
      await db.run('UPDATE matches SET turnOrder = ? WHERE userId = ? AND gameId = ?',
        [snapshot.before.turnOrder, snapshot.targetId, snapshot.gameId]);
    } else if (snapshot.operationType === 'bulk_turn_order_removal') {
      // Restore each game's turn order from the before state
      if (snapshot.before.gamesWithTurnOrder) {
        for (const game of snapshot.before.gamesWithTurnOrder) {
          await db.run('UPDATE matches SET turnOrder = ? WHERE userId = ? AND gameId = ?',
            [(game as any).turnOrder, snapshot.targetId, (game as any).gameId]);
        }
        logger.info(`[SNAPSHOT] Restored turn orders for ${snapshot.before.gamesWithTurnOrder.length} game(s)`);
      }
    }
  } else if (snapshot.targetType === 'deck') {
    if (snapshot.operationType === 'rating_change') {
      const { updateDeckRating } = await import('../db/deck-utils.js');
      // Need deck display name - get from database or snapshot metadata
      const deck = await db.get('SELECT displayName FROM decks WHERE normalizedName = ?', snapshot.targetId);
      await updateDeckRating(
        snapshot.targetId,
        deck?.displayName || snapshot.targetId,
        snapshot.before.mu!,
        snapshot.before.sigma!,
        snapshot.before.wins!,
        snapshot.before.losses!,
        snapshot.before.draws!
      );
    }
  } else if (snapshot.targetType === 'game') {
    if (snapshot.operationType === 'game_modification') {
      // Restore the active flag
      await db.run('UPDATE games_master SET active = ? WHERE gameId = ?',
        [snapshot.before.active ? 1 : 0, snapshot.targetId]);
      await db.run('UPDATE game_ids SET active = ? WHERE gameId = ?',
        [snapshot.before.active ? 1 : 0, snapshot.targetId]);

      // Restore match records to pre-modification state
      if (snapshot.before.matchRecords) {
        await db.run('DELETE FROM matches WHERE gameId = ?', snapshot.targetId);
        for (const record of snapshot.before.matchRecords) {
          await db.run(`
            INSERT INTO matches (id, gameId, userId, status, matchDate, mu, sigma, teams, scores, score, submittedByAdmin, turnOrder, gameSequence, assignedDeck)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [record.id, record.gameId, record.userId, record.status, record.matchDate,
              record.mu, record.sigma, record.teams, record.scores, record.score,
              record.submittedByAdmin, record.turnOrder, record.gameSequence, record.assignedDeck]);
        }
        logger.info(`[SNAPSHOT] Restored ${snapshot.before.matchRecords.length} match record(s) for game ${snapshot.targetId}`);
      }

      if (snapshot.before.deckMatchRecords) {
        await db.run('DELETE FROM deck_matches WHERE gameId = ?', snapshot.targetId);
        for (const record of snapshot.before.deckMatchRecords) {
          await db.run(`
            INSERT INTO deck_matches (id, gameId, deckNormalizedName, deckDisplayName, status, matchDate, mu, sigma, turnOrder, gameSequence, submittedByAdmin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [record.id, record.gameId, record.deckNormalizedName, record.deckDisplayName,
              record.status, record.matchDate, record.mu, record.sigma, record.turnOrder,
              record.gameSequence, record.submittedByAdmin]);
        }
        logger.info(`[SNAPSHOT] Restored ${snapshot.before.deckMatchRecords.length} deck match record(s) for game ${snapshot.targetId}`);
      }

      // Recalculate all ratings after restoring records
      const { recalculateAllPlayersFromScratch, recalculateAllDecksFromScratch } = await import('../commands/set.js');

      logger.info(`[SNAPSHOT] Recalculating all ratings after undoing game modification...`);
      await recalculateAllPlayersFromScratch();
      await recalculateAllDecksFromScratch();

      // Always run cleanup for consistency
      const { cleanupZeroPlayers, cleanupZeroDecks } = await import('../db/database-utils.js');
      const playerCleanup = await cleanupZeroPlayers();
      const deckCleanup = await cleanupZeroDecks();
      logger.info(`[SNAPSHOT] Cleanup: ${playerCleanup.cleanedPlayers} player(s), ${deckCleanup.cleanedDecks} deck(s)`);
    }
  }

  logger.info(`[SNAPSHOT] Undid ${snapshot.operationType} for ${snapshot.targetType} ${snapshot.targetId}`);
}

async function redoSetCommand(snapshot: SetCommandSnapshot): Promise<void> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();
  
  if (snapshot.targetType === 'player') {
    if (snapshot.operationType === 'rating_change') {
      const { updatePlayerRating } = await import('../db/player-utils.js');
      await updatePlayerRating(
        snapshot.targetId,
        snapshot.after.mu!,
        snapshot.after.sigma!,
        snapshot.after.wins!,
        snapshot.after.losses!,
        snapshot.after.draws!
      );
    } else if (snapshot.operationType === 'deck_assignment') {
      // Restore defaultDeck to "after" state
      if (snapshot.after.defaultDeck !== undefined) {
        await db.run('UPDATE players SET defaultDeck = ? WHERE userId = ?',
          [snapshot.after.defaultDeck, snapshot.targetId]);
      }

      // Restore match assignedDeck values to "after" state
      if (snapshot.after.matchAssignments) {
        for (const ma of snapshot.after.matchAssignments) {
          await db.run('UPDATE matches SET assignedDeck = ? WHERE userId = ? AND gameId = ?',
            [ma.assignedDeck, snapshot.targetId, ma.gameId]);
        }
      }

      // Restore player_deck_assignments to "after" state
      if (snapshot.after.playerDeckAssignments !== undefined) {
        await db.run('DELETE FROM player_deck_assignments WHERE userId = ?', snapshot.targetId);
        for (const pda of snapshot.after.playerDeckAssignments) {
          await db.run(`
            INSERT INTO player_deck_assignments (userId, gameId, deckNormalizedName, deckDisplayName, assignmentType, createdBy)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [pda.userId, pda.gameId, pda.deckNormalizedName, pda.deckDisplayName, pda.assignmentType, pda.createdBy]);
        }
      }

      // Recalculate if the original operation triggered recalculation
      if (snapshot.after.needsRecalculation) {
        const { recalculateAllPlayersFromScratch, recalculateAllDecksFromScratch } = await import('../commands/set.js');
        logger.info(`[SNAPSHOT] Recalculating all ratings after redoing deck assignment...`);
        await recalculateAllPlayersFromScratch();
        await recalculateAllDecksFromScratch();
        const { cleanupZeroPlayers, cleanupZeroDecks } = await import('../db/database-utils.js');
        await cleanupZeroPlayers();
        await cleanupZeroDecks();
      }
    } else if (snapshot.operationType === 'turn_order' || snapshot.operationType === 'turn_order_removal') {
      await db.run('UPDATE matches SET turnOrder = ? WHERE userId = ? AND gameId = ?',
        [snapshot.after.turnOrder, snapshot.targetId, snapshot.gameId]);
    } else if (snapshot.operationType === 'bulk_turn_order_removal') {
      // Re-apply bulk removal: set all turn orders to NULL
      if (snapshot.before.gamesWithTurnOrder) {
        for (const game of snapshot.before.gamesWithTurnOrder) {
          await db.run('UPDATE matches SET turnOrder = NULL WHERE userId = ? AND gameId = ?',
            [snapshot.targetId, (game as any).gameId]);
        }
        logger.info(`[SNAPSHOT] Re-removed turn orders for ${snapshot.before.gamesWithTurnOrder.length} game(s)`);
      }
    }
  } else if (snapshot.targetType === 'deck') {
    if (snapshot.operationType === 'rating_change') {
      const { updateDeckRating } = await import('../db/deck-utils.js');
      const deck = await db.get('SELECT displayName FROM decks WHERE normalizedName = ?', snapshot.targetId);
      await updateDeckRating(
        snapshot.targetId,
        deck?.displayName || snapshot.targetId,
        snapshot.after.mu!,
        snapshot.after.sigma!,
        snapshot.after.wins!,
        snapshot.after.losses!,
        snapshot.after.draws!
      );
    }
  } else if (snapshot.targetType === 'game') {
    if (snapshot.operationType === 'game_modification') {
      // Restore the active flag to "after" state
      await db.run('UPDATE games_master SET active = ? WHERE gameId = ?',
        [snapshot.after.active ? 1 : 0, snapshot.targetId]);
      await db.run('UPDATE game_ids SET active = ? WHERE gameId = ?',
        [snapshot.after.active ? 1 : 0, snapshot.targetId]);

      // Restore match records to post-modification state
      if (snapshot.after.matchRecords) {
        await db.run('DELETE FROM matches WHERE gameId = ?', snapshot.targetId);
        for (const record of snapshot.after.matchRecords) {
          await db.run(`
            INSERT INTO matches (id, gameId, userId, status, matchDate, mu, sigma, teams, scores, score, submittedByAdmin, turnOrder, gameSequence, assignedDeck)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [record.id, record.gameId, record.userId, record.status, record.matchDate,
              record.mu, record.sigma, record.teams, record.scores, record.score,
              record.submittedByAdmin, record.turnOrder, record.gameSequence, record.assignedDeck]);
        }
        logger.info(`[SNAPSHOT] Restored ${snapshot.after.matchRecords.length} match record(s) for game ${snapshot.targetId}`);
      }

      if (snapshot.after.deckMatchRecords) {
        await db.run('DELETE FROM deck_matches WHERE gameId = ?', snapshot.targetId);
        for (const record of snapshot.after.deckMatchRecords) {
          await db.run(`
            INSERT INTO deck_matches (id, gameId, deckNormalizedName, deckDisplayName, status, matchDate, mu, sigma, turnOrder, gameSequence, submittedByAdmin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [record.id, record.gameId, record.deckNormalizedName, record.deckDisplayName,
              record.status, record.matchDate, record.mu, record.sigma, record.turnOrder,
              record.gameSequence, record.submittedByAdmin]);
        }
        logger.info(`[SNAPSHOT] Restored ${snapshot.after.deckMatchRecords.length} deck match record(s) for game ${snapshot.targetId}`);
      }

      // Recalculate all ratings after restoring records
      const { recalculateAllPlayersFromScratch, recalculateAllDecksFromScratch } = await import('../commands/set.js');

      logger.info(`[SNAPSHOT] Recalculating all ratings after redoing game modification...`);
      await recalculateAllPlayersFromScratch();
      await recalculateAllDecksFromScratch();

      // Always run cleanup for consistency
      const { cleanupZeroPlayers, cleanupZeroDecks } = await import('../db/database-utils.js');
      const playerCleanup = await cleanupZeroPlayers();
      const deckCleanup = await cleanupZeroDecks();
      logger.info(`[SNAPSHOT] Cleanup: ${playerCleanup.cleanedPlayers} player(s), ${deckCleanup.cleanedDecks} deck(s)`);
    }
  }

  logger.info(`[SNAPSHOT] Redid ${snapshot.operationType} for ${snapshot.targetType} ${snapshot.targetId}`);
}

// Decay undo/redo handlers
async function undoDecay(snapshot: DecaySnapshot): Promise<void> {
  const { updatePlayerRatingForDecay } = await import('../db/player-utils.js');

  // Restore all players to their pre-decay state
  for (const player of snapshot.players) {
    await updatePlayerRatingForDecay(
      player.userId,
      player.beforeMu,
      player.beforeSigma,
      player.wins,
      player.losses,
      player.draws
    );
    logger.info(`[SNAPSHOT] Restored player ${player.userId} to pre-decay state`);
  }

  logger.info(`[SNAPSHOT] Undid decay affecting ${snapshot.players.length} players`);
}

async function redoDecay(snapshot: DecaySnapshot): Promise<void> {
  const { updatePlayerRatingForDecay } = await import('../db/player-utils.js');

  // Re-apply decay to all players
  for (const player of snapshot.players) {
    await updatePlayerRatingForDecay(
      player.userId,
      player.afterMu,
      player.afterSigma,
      player.wins,
      player.losses,
      player.draws
    );
    logger.info(`[SNAPSHOT] Re-applied decay to player ${player.userId}`);
  }

  logger.info(`[SNAPSHOT] Redid decay affecting ${snapshot.players.length} players`);
}

// Utility functions
async function ensureCompleteGameMetadata(snapshot: MatchSnapshot): Promise<void> {
  if (snapshot.matchData && snapshot.matchData.length > 0) {
    try {
      const { getDatabase } = await import('../db/init.js');
      const db = getDatabase();
      
      // Get game metadata to ensure we can restore it properly
      const gameInfo = await db.get(`
        SELECT submittedBy, submittedByAdmin, createdAt 
        FROM games_master 
        WHERE gameId = ?
      `, snapshot.gameId);
      
      if (gameInfo) {
        // Add this metadata to snapshot matchData for restoration
        for (const match of snapshot.matchData) {
          match.submittedBy = match.submittedBy || gameInfo.submittedBy;
          match.submittedByAdmin = match.submittedByAdmin !== undefined ? match.submittedByAdmin : gameInfo.submittedByAdmin;
          match.createdAt = match.createdAt || gameInfo.createdAt;
        }
      }
    } catch (error) {
      logger.error(`[SNAPSHOT] Error ensuring game metadata for ${snapshot.gameId}:`, error);
    }
  }
}

async function removeGameFromDatabase(gameId: string, gameType: 'player' | 'deck' | 'set_command'): Promise<void> {
  if (gameType === 'set_command') {
    logger.info(`[SNAPSHOT] Set command ${gameId} - no database records to remove`);
    return;
  }

  try {
    const { getDatabase } = await import('../db/init.js');
    const db = getDatabase();

    // Update status instead of deleting to preserve audit trail
    await db.run('UPDATE games_master SET status = ? WHERE gameId = ?', ['undone', gameId]);
    await db.run('UPDATE game_ids SET status = ? WHERE gameId = ?', ['undone', gameId]);

    // Remove match records (these can be recreated from snapshot data)
    // For your system, each game is either player OR deck, never both
    const playerMatches = await db.get('SELECT COUNT(*) as count FROM matches WHERE gameId = ?', gameId);
    const deckMatches = await db.get('SELECT COUNT(*) as count FROM deck_matches WHERE gameId = ?', gameId);

    if (playerMatches.count > 0) {
      await db.run('DELETE FROM matches WHERE gameId = ?', gameId);
      logger.info(`[SNAPSHOT] Removed ${playerMatches.count} player matches for game ${gameId}`);
    }

    if (deckMatches.count > 0) {
      await db.run('DELETE FROM deck_matches WHERE gameId = ?', gameId);
      logger.info(`[SNAPSHOT] Removed ${deckMatches.count} deck matches for game ${gameId}`);
    }

    const gameDescription = gameType === 'player' ? 'player' : 'deck';
    
    logger.info(`[SNAPSHOT] Removed ${gameDescription} game ${gameId} from database`);
  } catch (error) {
    logger.error(`[SNAPSHOT] Error removing game ${gameId}:`, error);
    throw error;
  }
}

// Snapshot diff calculation functions
export function getPlayerSnapshotDiffs(before: PlayerSnapshot[], after: PlayerSnapshot[]) {
  return before.map((b) => {
    const a = after.find((p) => p.userId === b.userId) ?? b;
    return {
      tag: b.tag,
      turnOrder: b.turnOrder,
      commander: b.commander,
      beforeElo: calculateElo(b.mu, b.sigma).toFixed(0),
      afterElo: calculateElo(a.mu, a.sigma).toFixed(0),
      beforeMu: b.mu.toFixed(2),
      afterMu: a.mu.toFixed(2),
      beforeSigma: b.sigma.toFixed(2),
      afterSigma: a.sigma.toFixed(2),
      beforeW: b.wins,
      afterW: a.wins,
      beforeL: b.losses,
      afterL: a.losses,
      beforeD: b.draws,
      afterD: a.draws,
    };
  });
}

export function getDeckSnapshotDiffs(before: DeckSnapshot[], after: DeckSnapshot[]) {
  return before.map((b) => {
    const a = after.find((d) => d.normalizedName === b.normalizedName) ?? b;
    return {
      displayName: b.displayName,
      turnOrder: b.turnOrder,
      beforeElo: calculateElo(b.mu, b.sigma).toFixed(0),
      afterElo: calculateElo(a.mu, a.sigma).toFixed(0),
      beforeMu: b.mu.toFixed(2),
      afterMu: a.mu.toFixed(2),
      beforeSigma: b.sigma.toFixed(2),
      afterSigma: a.sigma.toFixed(2),
      beforeW: b.wins,
      afterW: a.wins,
      beforeL: b.losses,
      afterL: a.losses,
      beforeD: b.draws,
      afterD: a.draws,
    };
  });
}

// Advanced stack operations
export function peekLastOperation(): UniversalSnapshot | null {
  return rankOpHistoryStack.length > 0 ? rankOpHistoryStack[rankOpHistoryStack.length - 1] : null;
}

export function peekLastUndoneOperation(): UniversalSnapshot | null {
  return undoneStack.length > 0 ? undoneStack[undoneStack.length - 1] : null;
}

export function getAllActiveOperations(): UniversalSnapshot[] {
  return [...rankOpHistoryStack]; // Return copy to prevent mutation
}

export function getAllUndoneOperations(): UniversalSnapshot[] {
  return [...undoneStack]; // Return copy to prevent mutation
}

export function findOperationByGameId(gameId: string): UniversalSnapshot | null {
  return rankOpHistoryStack.find(snapshot => snapshot.gameId === gameId) || null;
}

export function findUndoneOperationByGameId(gameId: string): UniversalSnapshot | null {
  return undoneStack.find(snapshot => snapshot.gameId === gameId) || null;
}

// Stack maintenance functions
export function removeFromActiveStack(gameId: string): boolean {
  const index = rankOpHistoryStack.findIndex(snapshot => snapshot.gameId === gameId);
  if (index !== -1) {
    rankOpHistoryStack.splice(index, 1);
    logger.info(`[SNAPSHOT] Removed game ${gameId} from active stack`);
    return true;
  }
  return false;
}

export function removeFromUndoneStack(gameId: string): boolean {
  const index = undoneStack.findIndex(snapshot => snapshot.gameId === gameId);
  if (index !== -1) {
    undoneStack.splice(index, 1);
    logger.info(`[SNAPSHOT] Removed game ${gameId} from undone stack`);
    return true;
  }
  return false;
}

// Validation functions
export function validateSnapshot(snapshot: UniversalSnapshot): boolean {
  if (!snapshot.gameId || !snapshot.gameType) {
    logger.error('[SNAPSHOT] Invalid snapshot: missing required fields');
    return false;
  }

  if (snapshot.gameType === 'set_command') {
    const setSnapshot = snapshot as SetCommandSnapshot;
    if (!setSnapshot.operationType || !setSnapshot.targetType || !setSnapshot.targetId) {
      logger.error('[SNAPSHOT] Invalid set command snapshot: missing operation details');
      return false;
    }
  } else {
    const matchSnapshot = snapshot as MatchSnapshot;
    if (!matchSnapshot.matchData || (matchSnapshot.before.length === 0 && matchSnapshot.after.length === 0)) {
      logger.error('[SNAPSHOT] Invalid match snapshot: no match data or before/after data');
      return false;
    }
  }

  return true;
}

// Create snapshot from current database state (for games not in stack)
export async function createSnapshotFromCurrentState(gameId: string, gameType: 'player' | 'deck', matches: any[]): Promise<MatchSnapshot> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  // Get game info
  const gameInfo = await db.get('SELECT * FROM games_master WHERE gameId = ?', gameId);
  const gameSequence = gameInfo?.gameSequence || 0;

  // Check for both player and deck matches (your system uses one or the other, not both)
  const playerMatches = await db.all('SELECT * FROM matches WHERE gameId = ?', gameId);
  const deckMatches = await db.all('SELECT * FROM deck_matches WHERE gameId = ?', gameId);

  // Combine all match data 
  const allMatchData = [...playerMatches, ...deckMatches];

  const snapshot: MatchSnapshot = {
    matchId: `manual-${gameId}`,
    gameId: gameId,
    gameSequence: gameSequence,
    gameType: gameType,
    matchData: allMatchData.length > 0 ? allMatchData : matches,
    before: [],
    after: [],
    timestamp: new Date().toISOString(),
    description: `${gameType} game ${gameId}`
  };

  // Process player matches
  if (playerMatches.length > 0) {
    for (const match of playerMatches) {
      const currentPlayer = await db.get('SELECT * FROM players WHERE userId = ?', match.userId);
      if (!currentPlayer) continue;

      // Calculate pre-game state (reverse the game effects)
      const beforeWins = currentPlayer.wins - (match.status === 'w' ? 1 : 0);
      const beforeLosses = currentPlayer.losses - (match.status === 'l' ? 1 : 0);
      const beforeDraws = currentPlayer.draws - (match.status === 'd' ? 1 : 0);

      // Try to get Discord username for display
      let playerTag = `User ${match.userId}`;
      try {
        // Note: This will be updated with actual username in the calling function
        playerTag = `<@${match.userId}>`;
      } catch {
        playerTag = `User ${match.userId}`;
      }

      const beforeSnapshot: PlayerSnapshot = {
        userId: match.userId,
        mu: match.mu, // Post-game mu/sigma stored in match (for restoration)
        sigma: match.sigma,
        wins: beforeWins,
        losses: beforeLosses,
        draws: beforeDraws,
        tag: playerTag,
        turnOrder: match.turnOrder,
        commander: match.assignedDeck,
        lastPlayed: currentPlayer.lastPlayed // Capture current lastPlayed for undo restoration
      };

      const afterSnapshot: PlayerSnapshot = {
        userId: match.userId,
        mu: currentPlayer.mu,
        sigma: currentPlayer.sigma,
        wins: currentPlayer.wins,
        losses: currentPlayer.losses,
        draws: currentPlayer.draws,
        tag: playerTag,
        turnOrder: match.turnOrder,
        commander: match.assignedDeck,
        lastPlayed: currentPlayer.lastPlayed
      };

      snapshot.before.push(beforeSnapshot);
      snapshot.after.push(afterSnapshot);
    }
  }

  // Process deck matches
  if (deckMatches.length > 0) {
    for (const match of deckMatches) {
      const currentDeck = await db.get('SELECT * FROM decks WHERE normalizedName = ?', match.deckNormalizedName);
      if (!currentDeck) continue;

      const beforeWins = currentDeck.wins - (match.status === 'w' ? 1 : 0);
      const beforeLosses = currentDeck.losses - (match.status === 'l' ? 1 : 0);
      const beforeDraws = currentDeck.draws - (match.status === 'd' ? 1 : 0);

      const beforeSnapshot: DeckSnapshot = {
        normalizedName: match.deckNormalizedName,
        displayName: match.deckDisplayName,
        mu: match.mu,
        sigma: match.sigma,
        wins: beforeWins,
        losses: beforeLosses,
        draws: beforeDraws,
        turnOrder: match.turnOrder
      };

      const afterSnapshot: DeckSnapshot = {
        normalizedName: match.deckNormalizedName,
        displayName: match.deckDisplayName,
        mu: currentDeck.mu,
        sigma: currentDeck.sigma,
        wins: currentDeck.wins,
        losses: currentDeck.losses,
        draws: currentDeck.draws,
        turnOrder: match.turnOrder
      };

      snapshot.before.push(beforeSnapshot);
      snapshot.after.push(afterSnapshot);
    }
  }

  // Note: Don't add to undone stack here - that should be done by the caller if needed
  
  logger.info(`[SNAPSHOT] Created snapshot from current state for ${snapshot.description}`);
  return snapshot;
}

// Debug functions
export function printStackStatus(): void {
  logger.info(`[SNAPSHOT] Stack Status:`);
  logger.info(`  Active Operations: ${rankOpHistoryStack.length}`);
  logger.info(`  Undone Operations: ${undoneStack.length}`);
  
  if (rankOpHistoryStack.length > 0) {
    const latest = rankOpHistoryStack[rankOpHistoryStack.length - 1];
    logger.info(`  Latest Active: ${latest.gameType} ${latest.gameId}`);
  }
  
  if (undoneStack.length > 0) {
    const latest = undoneStack[undoneStack.length - 1];
    logger.info(`  Latest Undone: ${latest.gameType} ${latest.gameId}`);
  }
}