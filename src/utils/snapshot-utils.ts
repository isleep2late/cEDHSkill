import { calculateElo } from './elo-utils.js';

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
  
  // Clear redo stack when new operation is saved
  undoneStack.length = 0;
  
  console.log(`[SNAPSHOT] Saved ${snapshot.description} to stack (${rankOpHistoryStack.length} total)`);
}

export function saveOperationSnapshot(snapshot: UniversalSnapshot): void {
  if (!snapshot.timestamp) {
    snapshot.timestamp = new Date().toISOString();
  }
  
  rankOpHistoryStack.push(snapshot);
  undoneStack.length = 0; // Clear redo stack
  
  console.log(`[SNAPSHOT] Saved ${snapshot.gameType} operation to stack (${rankOpHistoryStack.length} total)`);
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
  console.log('[SNAPSHOT] Cleared all stacks');
}

// Unified undo/redo operations
export async function undoLastOperation(): Promise<UniversalSnapshot | null> {
  if (rankOpHistoryStack.length === 0) {
    console.log('[SNAPSHOT] No operations to undo');
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

  console.log(`[SNAPSHOT] Undid operation: ${snapshot.gameType} (${rankOpHistoryStack.length} remaining, ${undoneStack.length} undone)`);
  return snapshot;
}

export async function redoLastOperation(): Promise<UniversalSnapshot | null> {
  if (undoneStack.length === 0) {
    console.log('[SNAPSHOT] No operations to redo');
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

  console.log(`[SNAPSHOT] Redid operation: ${snapshot.gameType} (${rankOpHistoryStack.length} active, ${undoneStack.length} undone)`);
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
    console.log(`[SNAPSHOT] Game ${gameId} not found in active stack`);
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
  
  console.log(`[SNAPSHOT] Undid ${undoneSnapshots.length} operations back to game ${gameId}`);
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
      
      console.log(`[SNAPSHOT] Undid deck game ${snapshot.gameId} from position ${i}`);
      return snapshot;
    }
  }
  
  console.log('[SNAPSHOT] No deck games found in stack to undo');
  return null;
}

export async function redoLastDeckMatch(): Promise<MatchSnapshot | null> {
  // Find last deck match in undone stack (reverse search)
  for (let i = undoneStack.length - 1; i >= 0; i--) {
    if (undoneStack[i].gameType === 'deck') {
      const snapshot = undoneStack.splice(i, 1)[0] as MatchSnapshot;
      rankOpHistoryStack.push(snapshot);
      
      console.log(`[SNAPSHOT] Redid deck game ${snapshot.gameId} from undone stack position ${i}`);
      return snapshot;
    }
  }
  
  console.log('[SNAPSHOT] No deck games found in undone stack to redo');
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
      if (snapshot.before.defaultDeck !== undefined) {
        await db.run('UPDATE players SET defaultDeck = ? WHERE userId = ?', 
          [snapshot.before.defaultDeck, snapshot.targetId]);
      }
      if (snapshot.before.gameSpecificDeck !== undefined) {
        if (snapshot.before.gameSpecificDeck === null) {
          await db.run('DELETE FROM player_deck_assignments WHERE userId = ? AND gameId = ?', 
            [snapshot.targetId, snapshot.gameId]);
        } else {
          await db.run(`
            INSERT OR REPLACE INTO player_deck_assignments 
            (userId, gameId, deckNormalizedName, deckDisplayName, assignmentType, createdBy)
            VALUES (?, ?, ?, ?, 'game_specific', ?)
          `, [snapshot.targetId, snapshot.gameId, snapshot.before.gameSpecificDeck, 
              snapshot.before.gameSpecificDeck, snapshot.metadata.adminUserId]);
        }
      }
    } else if (snapshot.operationType === 'turn_order') {
      await db.run('UPDATE matches SET turnOrder = ? WHERE userId = ? AND gameId = ?', 
        [snapshot.before.turnOrder, snapshot.targetId, snapshot.gameId]);
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

      // CRITICAL: Recalculate all ratings after changing game active status
      // This mirrors what /set does when modifying game active status
      const { recalculateAllPlayersFromScratch, recalculateAllDecksFromScratch } = await import('../commands/set.js');

      console.log(`[SNAPSHOT] Recalculating all ratings after undoing game activation change...`);
      await recalculateAllPlayersFromScratch();
      await recalculateAllDecksFromScratch();

      // Always run cleanup for consistency after game activation changes
      const { cleanupZeroPlayers, cleanupZeroDecks } = await import('../db/database-utils.js');
      const playerCleanup = await cleanupZeroPlayers();
      const deckCleanup = await cleanupZeroDecks();
      console.log(`[SNAPSHOT] Cleanup: ${playerCleanup.cleanedPlayers} player(s), ${deckCleanup.cleanedDecks} deck(s)`);
    }
  }

  console.log(`[SNAPSHOT] Undid ${snapshot.operationType} for ${snapshot.targetType} ${snapshot.targetId}`);
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
      if (snapshot.after.defaultDeck !== undefined) {
        await db.run('UPDATE players SET defaultDeck = ? WHERE userId = ?', 
          [snapshot.after.defaultDeck, snapshot.targetId]);
      }
      if (snapshot.after.gameSpecificDeck !== undefined) {
        if (snapshot.after.gameSpecificDeck === null) {
          await db.run('DELETE FROM player_deck_assignments WHERE userId = ? AND gameId = ?', 
            [snapshot.targetId, snapshot.gameId]);
        } else {
          await db.run(`
            INSERT OR REPLACE INTO player_deck_assignments 
            (userId, gameId, deckNormalizedName, deckDisplayName, assignmentType, createdBy)
            VALUES (?, ?, ?, ?, 'game_specific', ?)
          `, [snapshot.targetId, snapshot.gameId, snapshot.after.gameSpecificDeck, 
              snapshot.after.gameSpecificDeck, snapshot.metadata.adminUserId]);
        }
      }
    } else if (snapshot.operationType === 'turn_order') {
      await db.run('UPDATE matches SET turnOrder = ? WHERE userId = ? AND gameId = ?', 
        [snapshot.after.turnOrder, snapshot.targetId, snapshot.gameId]);
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

      // CRITICAL: Recalculate all ratings after changing game active status
      // This mirrors what /set does when modifying game active status
      const { recalculateAllPlayersFromScratch, recalculateAllDecksFromScratch } = await import('../commands/set.js');

      console.log(`[SNAPSHOT] Recalculating all ratings after redoing game activation change...`);
      await recalculateAllPlayersFromScratch();
      await recalculateAllDecksFromScratch();

      // Always run cleanup for consistency after game activation changes
      const { cleanupZeroPlayers, cleanupZeroDecks } = await import('../db/database-utils.js');
      const playerCleanup = await cleanupZeroPlayers();
      const deckCleanup = await cleanupZeroDecks();
      console.log(`[SNAPSHOT] Cleanup: ${playerCleanup.cleanedPlayers} player(s), ${deckCleanup.cleanedDecks} deck(s)`);
    }
  }

  console.log(`[SNAPSHOT] Redid ${snapshot.operationType} for ${snapshot.targetType} ${snapshot.targetId}`);
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
    console.log(`[SNAPSHOT] Restored player ${player.userId} to pre-decay state`);
  }

  console.log(`[SNAPSHOT] Undid decay affecting ${snapshot.players.length} players`);
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
    console.log(`[SNAPSHOT] Re-applied decay to player ${player.userId}`);
  }

  console.log(`[SNAPSHOT] Redid decay affecting ${snapshot.players.length} players`);
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
      console.error(`[SNAPSHOT] Error ensuring game metadata for ${snapshot.gameId}:`, error);
    }
  }
}

async function removeGameFromDatabase(gameId: string, gameType: 'player' | 'deck' | 'set_command'): Promise<void> {
  if (gameType === 'set_command') {
    console.log(`[SNAPSHOT] Set command ${gameId} - no database records to remove`);
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
      console.log(`[SNAPSHOT] Removed ${playerMatches.count} player matches for game ${gameId}`);
    }

    if (deckMatches.count > 0) {
      await db.run('DELETE FROM deck_matches WHERE gameId = ?', gameId);
      console.log(`[SNAPSHOT] Removed ${deckMatches.count} deck matches for game ${gameId}`);
    }

    const gameDescription = gameType === 'player' ? 'player' : 'deck';
    
    console.log(`[SNAPSHOT] Removed ${gameDescription} game ${gameId} from database`);
  } catch (error) {
    console.error(`[SNAPSHOT] Error removing game ${gameId}:`, error);
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
    console.log(`[SNAPSHOT] Removed game ${gameId} from active stack`);
    return true;
  }
  return false;
}

export function removeFromUndoneStack(gameId: string): boolean {
  const index = undoneStack.findIndex(snapshot => snapshot.gameId === gameId);
  if (index !== -1) {
    undoneStack.splice(index, 1);
    console.log(`[SNAPSHOT] Removed game ${gameId} from undone stack`);
    return true;
  }
  return false;
}

// Validation functions
export function validateSnapshot(snapshot: UniversalSnapshot): boolean {
  if (!snapshot.gameId || !snapshot.gameType) {
    console.error('[SNAPSHOT] Invalid snapshot: missing required fields');
    return false;
  }

  if (snapshot.gameType === 'set_command') {
    const setSnapshot = snapshot as SetCommandSnapshot;
    if (!setSnapshot.operationType || !setSnapshot.targetType || !setSnapshot.targetId) {
      console.error('[SNAPSHOT] Invalid set command snapshot: missing operation details');
      return false;
    }
  } else {
    const matchSnapshot = snapshot as MatchSnapshot;
    if (!matchSnapshot.matchData || (matchSnapshot.before.length === 0 && matchSnapshot.after.length === 0)) {
      console.error('[SNAPSHOT] Invalid match snapshot: no match data or before/after data');
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
        mu: match.mu, // Pre-game mu/sigma stored in match
        sigma: match.sigma,
        wins: beforeWins,
        losses: beforeLosses,
        draws: beforeDraws,
        tag: playerTag,
        turnOrder: match.turnOrder,
        commander: match.assignedDeck
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
        commander: match.assignedDeck
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
  
  console.log(`[SNAPSHOT] Created snapshot from current state for ${snapshot.description}`);
  return snapshot;
}

// Debug functions
export function printStackStatus(): void {
  console.log(`[SNAPSHOT] Stack Status:`);
  console.log(`  Active Operations: ${rankOpHistoryStack.length}`);
  console.log(`  Undone Operations: ${undoneStack.length}`);
  
  if (rankOpHistoryStack.length > 0) {
    const latest = rankOpHistoryStack[rankOpHistoryStack.length - 1];
    console.log(`  Latest Active: ${latest.gameType} ${latest.gameId}`);
  }
  
  if (undoneStack.length > 0) {
    const latest = undoneStack[undoneStack.length - 1];
    console.log(`  Latest Undone: ${latest.gameType} ${latest.gameId}`);
  }
}