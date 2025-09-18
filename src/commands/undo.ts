import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder 
} from 'discord.js';
import { config } from '../config.js';
import { getDatabase } from '../db/init.js';
import { updateDeckRating, getOrCreateDeck, getAllDecks } from '../db/deck-utils.js';
import { 
  cleanupZeroPlayers,
  cleanupZeroDecks,
  getGameType,
  getMatchesByGameId,
  getDeckMatchesByGameId
} from '../db/database-utils.js';
import { 
  undoLastOperation,
  undoToSpecificGame,
  getPlayerSnapshotDiffs,
  getDeckSnapshotDiffs,
  MatchSnapshot,
  PlayerSnapshot,
  DeckSnapshot,
  UniversalSnapshot, 
  SetCommandSnapshot,
  undoLastMatch,
  findOperationByGameId,
  createSnapshotFromCurrentState
} from '../utils/snapshot-utils.js';
import { updatePlayerRating, getOrCreatePlayer, getAllPlayers } from '../db/player-utils.js';
import { logRatingChange } from '../utils/rating-audit-utils.js';
import { calculateElo } from '../utils/elo-utils.js';

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('undo')
  .setDescription('Undo the latest operation (game or /set command)');

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const isAdmin = hasModAccess(userId);

  if (!isAdmin) {
    await interaction.reply({
      content: 'Only administrators can undo operations.',
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Standard single undo only
    const undoneSnapshot = await undoLastOperation();
    if (!undoneSnapshot) {
      await interaction.editReply({
        content: 'No operations found to undo.'
      });
      return;
    }

    // Restore ratings to before-operation state for match operations only
    // Set command operations are handled internally by undoLastOperation()
    if (undoneSnapshot.gameType !== 'set_command') {
      const matchSnapshot = undoneSnapshot as MatchSnapshot;
      await restoreRatingsFromSnapshot(matchSnapshot, userId);
    }

    // Create response embed
    const embed = await createUndoEmbed([undoneSnapshot], interaction);
    await interaction.editReply({ embeds: [embed] });

    // Cleanup players/decks with 0/0/0 records
    const playerCleanup = await cleanupZeroPlayers();
    const deckCleanup = await cleanupZeroDecks();
    
    if (playerCleanup.cleanedPlayers > 0 || deckCleanup.cleanedDecks > 0) {
      await interaction.followUp({
        content: `Cleanup: Removed ${playerCleanup.cleanedPlayers} players and ${deckCleanup.cleanedDecks} decks with 0/0/0 records.`,
        ephemeral: true
      });
    }

  } catch (error) {
    console.error('Error undoing operation:', error);
    await interaction.editReply({
      content: 'An error occurred while undoing the operation. Please check the logs for details.'
    });
  }
}

async function restoreRatingsFromSnapshot(snapshot: MatchSnapshot, adminUserId: string): Promise<void> {
  console.log(`[UNDO] Restoring ratings from snapshot for ${snapshot.gameType} game ${snapshot.gameId}`);

  // Restore player ratings to before-game state
  const playerBefore = snapshot.before.filter(s => 'userId' in s) as PlayerSnapshot[];
  for (const playerSnapshot of playerBefore) {
    console.log(`[UNDO] Restoring player ${playerSnapshot.userId} to mu: ${playerSnapshot.mu}, sigma: ${playerSnapshot.sigma}, W/L/D: ${playerSnapshot.wins}/${playerSnapshot.losses}/${playerSnapshot.draws}`);
    
    await updatePlayerRating(
      playerSnapshot.userId,
      playerSnapshot.mu,
      playerSnapshot.sigma,
      playerSnapshot.wins,
      playerSnapshot.losses,
      playerSnapshot.draws
    );

    // Log the reversion for audit purposes
    const afterSnapshot = snapshot.after.find(s => 'userId' in s && s.userId === playerSnapshot.userId) as PlayerSnapshot;
    if (afterSnapshot) {
      await logRatingChange({
        targetType: 'player',
        targetId: playerSnapshot.userId,
        targetDisplayName: playerSnapshot.tag,
        changeType: 'undo',
        adminUserId,
        oldMu: afterSnapshot.mu,
        oldSigma: afterSnapshot.sigma,
        oldElo: calculateElo(afterSnapshot.mu, afterSnapshot.sigma),
        newMu: playerSnapshot.mu,
        newSigma: playerSnapshot.sigma,
        newElo: calculateElo(playerSnapshot.mu, playerSnapshot.sigma),
        oldWins: afterSnapshot.wins,
        oldLosses: afterSnapshot.losses,
        oldDraws: afterSnapshot.draws,
        newWins: playerSnapshot.wins,
        newLosses: playerSnapshot.losses,
        newDraws: playerSnapshot.draws,
        reason: `Undo ${snapshot.gameType} game ${snapshot.gameId}`
      });
    }
  }

  // Restore deck ratings to before-game state
  const deckBefore = snapshot.before.filter(s => 'normalizedName' in s) as DeckSnapshot[];
  for (const deckSnapshot of deckBefore) {
    console.log(`[UNDO] Restoring deck ${deckSnapshot.normalizedName} to mu: ${deckSnapshot.mu}, sigma: ${deckSnapshot.sigma}, W/L/D: ${deckSnapshot.wins}/${deckSnapshot.losses}/${deckSnapshot.draws}`);
    
    await updateDeckRating(
      deckSnapshot.normalizedName,
      deckSnapshot.displayName,
      deckSnapshot.mu,
      deckSnapshot.sigma,
      deckSnapshot.wins,
      deckSnapshot.losses,
      deckSnapshot.draws
    );

    // Log the reversion for audit purposes
    const afterSnapshot = snapshot.after.find(s => 'normalizedName' in s && s.normalizedName === deckSnapshot.normalizedName) as DeckSnapshot;
    if (afterSnapshot) {
      await logRatingChange({
        targetType: 'deck',
        targetId: deckSnapshot.normalizedName,
        targetDisplayName: deckSnapshot.displayName,
        changeType: 'undo',
        adminUserId,
        oldMu: afterSnapshot.mu,
        oldSigma: afterSnapshot.sigma,
        oldElo: calculateElo(afterSnapshot.mu, afterSnapshot.sigma),
        newMu: deckSnapshot.mu,
        newSigma: deckSnapshot.sigma,
        newElo: calculateElo(deckSnapshot.mu, deckSnapshot.sigma),
        oldWins: afterSnapshot.wins,
        oldLosses: afterSnapshot.losses,
        oldDraws: afterSnapshot.draws,
        newWins: deckSnapshot.wins,
        newLosses: deckSnapshot.losses,
        newDraws: deckSnapshot.draws,
        reason: `Undo ${snapshot.gameType} game ${snapshot.gameId}`
      });
    }
  }

  console.log(`[UNDO] Completed rating restoration for ${snapshot.gameType} game ${snapshot.gameId}`);
}

async function createUndoEmbed(undoneSnapshots: UniversalSnapshot[], interaction: ChatInputCommandInteraction): Promise<EmbedBuilder> {
  const firstSnapshot = undoneSnapshots[0];
  
  const embed = new EmbedBuilder()
    .setTitle('Operation Undone')
    .setColor(0xFF6B6B)
    .setFooter({ text: 'Use /redo to restore this operation' })
    .setTimestamp();

  if (firstSnapshot.gameType === 'set_command') {
    const setSnapshot = firstSnapshot as SetCommandSnapshot;
    embed.setDescription(`Successfully undone **${setSnapshot.operationType}**: **${setSnapshot.description}**`);
    
    // Show what changed for set commands
    let changesSummary = '';
    if (setSnapshot.operationType === 'rating_change') {
      const oldElo = calculateElo(setSnapshot.after.mu!, setSnapshot.after.sigma!);
      const newElo = calculateElo(setSnapshot.before.mu!, setSnapshot.before.sigma!);
      changesSummary = `Elo: ${oldElo.toFixed(0)} → ${newElo.toFixed(0)}`;
      
      if (setSnapshot.before.wins !== setSnapshot.after.wins) {
        changesSummary += `\nW/L/D: ${setSnapshot.after.wins}/${setSnapshot.after.losses}/${setSnapshot.after.draws} → ${setSnapshot.before.wins}/${setSnapshot.before.losses}/${setSnapshot.before.draws}`;
      }
    } else if (setSnapshot.operationType === 'deck_assignment') {
      const oldDeck = setSnapshot.after.defaultDeck || setSnapshot.after.gameSpecificDeck || 'None';
      const newDeck = setSnapshot.before.defaultDeck || setSnapshot.before.gameSpecificDeck || 'None';
      changesSummary = `Deck Assignment: ${oldDeck} → ${newDeck}`;
    } else if (setSnapshot.operationType === 'game_modification') {
      const oldActive = setSnapshot.after.active ? 'Active' : 'Inactive';
      const newActive = setSnapshot.before.active ? 'Active' : 'Inactive';
      changesSummary = `Game Status: ${oldActive} → ${newActive}`;
    } else if (setSnapshot.operationType === 'turn_order') {
      const oldOrder = setSnapshot.after.turnOrder || 'None';
      const newOrder = setSnapshot.before.turnOrder || 'None';
      changesSummary = `Turn Order: ${oldOrder} → ${newOrder}`;
    }
    
    if (changesSummary) {
      embed.addFields({
        name: 'Changes Reverted',
        value: changesSummary,
        inline: false
      });
    }
  } else {
    const matchSnapshot = firstSnapshot as MatchSnapshot;
    
    // Simple game type determination - either 'player' or 'deck'
    const gameTypeDescription = matchSnapshot.gameType === 'player' ? 'Player' : 'Deck';
    
    embed.setDescription(`Successfully undone **${gameTypeDescription}** game: **${matchSnapshot.gameId}**`);
  }

  // Show rating changes for the undone operation
  const snapshot = firstSnapshot;
  
  // Add player diffs if any
  const playerBefore = Array.isArray(snapshot.before) 
    ? snapshot.before.filter((s: any) => 'userId' in s) as PlayerSnapshot[]
    : [];
  const playerAfter = Array.isArray(snapshot.after) 
    ? snapshot.after.filter((s: any) => 'userId' in s) as PlayerSnapshot[]
    : [];
  
  if (playerBefore.length > 0) {
    const playerDiffs = getPlayerSnapshotDiffs(playerAfter, playerBefore); // Reversed for undo
    
    let playerSummary = '';
    for (let i = 0; i < Math.min(8, playerDiffs.length); i++) {
      const diff = playerDiffs[i];
      const playerData = playerBefore[i];
      
      try {
        // Try to get Discord username
        const user = await interaction.client.users.fetch(playerData.userId);
        const turnOrder = playerData.turnOrder ? ` [Turn ${playerData.turnOrder}]` : '';
        const commander = playerData.commander ? ` [${playerData.commander}]` : '';
        playerSummary += `@${user.username}${turnOrder}${commander}: ${diff.afterElo} → ${diff.beforeElo} Elo`;
        
        // Add W/L/D changes if they exist
        if (diff.beforeW !== diff.afterW || diff.beforeL !== diff.afterL || diff.beforeD !== diff.afterD) {
          playerSummary += ` (${diff.afterW}/${diff.afterL}/${diff.afterD} → ${diff.beforeW}/${diff.beforeL}/${diff.beforeD})`;
        }
        playerSummary += '\n';
      } catch {
        // Fallback to user ID
        const turnOrder = playerData.turnOrder ? ` [Turn ${playerData.turnOrder}]` : '';
        const commander = playerData.commander ? ` [${playerData.commander}]` : '';
        playerSummary += `<@${playerData.userId}>${turnOrder}${commander}: ${diff.afterElo} → ${diff.beforeElo} Elo`;
        
        if (diff.beforeW !== diff.afterW || diff.beforeL !== diff.afterL || diff.beforeD !== diff.afterD) {
          playerSummary += ` (${diff.afterW}/${diff.afterL}/${diff.afterD} → ${diff.beforeW}/${diff.beforeL}/${diff.beforeD})`;
        }
        playerSummary += '\n';
      }
    }
    
    const moreText = playerDiffs.length > 8 ? `... and ${playerDiffs.length - 8} more players` : '';
    
    embed.addFields({
      name: 'Player Changes',
      value: (playerSummary + moreText).trim() || 'No player changes',
      inline: false
    });
  }

  // Add deck diffs if any
  const deckBefore = Array.isArray(snapshot.before) 
    ? snapshot.before.filter((s: any) => 'normalizedName' in s) as DeckSnapshot[]
    : [];
  const deckAfter = Array.isArray(snapshot.after) 
    ? snapshot.after.filter((s: any) => 'normalizedName' in s) as DeckSnapshot[]
    : [];
  
  if (deckBefore.length > 0) {
    const deckDiffs = getDeckSnapshotDiffs(deckAfter, deckBefore); // Reversed for undo
    const deckSummary = deckDiffs.slice(0, 8).map(diff => {
      const deckData = deckBefore.find(d => d.displayName === diff.displayName);
      const turnOrder = deckData?.turnOrder ? ` [Turn ${deckData.turnOrder}]` : '';
      let summary = `${diff.displayName}${turnOrder}: ${diff.afterElo} → ${diff.beforeElo} Elo`;
      
      // Add W/L/D changes if they exist
      if (diff.beforeW !== diff.afterW || diff.beforeL !== diff.afterL || diff.beforeD !== diff.afterD) {
        summary += ` (${diff.afterW}/${diff.afterL}/${diff.afterD} → ${diff.beforeW}/${diff.beforeL}/${diff.beforeD})`;
      }
      
      return summary;
    }).join('\n');
    
    const moreText = deckDiffs.length > 8 ? `\n... and ${deckDiffs.length - 8} more decks` : '';
    
    embed.addFields({
      name: 'Deck Changes',
      value: deckSummary + moreText || 'No deck changes',
      inline: false
    });
  }

  // Add helpful information about what was undone
  if (firstSnapshot.gameType !== 'set_command') {
    const matchSnapshot = firstSnapshot as MatchSnapshot;
    
    // Check if this was a game with turn order or commander assignments
    let gameFeatures = [];
    
    if (playerBefore.some(p => p.turnOrder !== undefined)) {
      gameFeatures.push('turn order assignments');
    }
    
    if (playerBefore.some(p => p.commander !== undefined)) {
      gameFeatures.push('commander assignments');
    }
    
    if (deckBefore.some(d => d.turnOrder !== undefined)) {
      gameFeatures.push('turn order data');
    }
    
    if (gameFeatures.length > 0) {
      embed.addFields({
        name: 'Additional Data Restored',
        value: `This game included: ${gameFeatures.join(', ')}`,
        inline: false
      });
    }
  }

  return embed;
}

// Additional utility functions for comprehensive undo support

async function validateGameExists(gameId: string): Promise<boolean> {
  const db = getDatabase();
  const game = await db.get('SELECT gameId FROM games_master WHERE gameId = ? AND status = "confirmed"', gameId);
  return !!game;
}

async function getGameDetails(gameId: string): Promise<any> {
  const db = getDatabase();
  return await db.get('SELECT * FROM games_master WHERE gameId = ?', gameId);
}

async function findAffectedEntities(gameId: string, gameType: 'player' | 'deck'): Promise<{
  playerIds: string[],
  deckNames: string[]
}> {
  const db = getDatabase();
  let playerIds: string[] = [];
  let deckNames: string[] = [];

  if (gameType === 'player') {
    const playerMatches = await db.all('SELECT DISTINCT userId FROM matches WHERE gameId = ?', gameId);
    playerIds = playerMatches.map(m => m.userId);
    
    // Also get any assigned decks from player matches
    const assignedDecks = await db.all('SELECT DISTINCT assignedDeck FROM matches WHERE gameId = ? AND assignedDeck IS NOT NULL', gameId);
    deckNames = assignedDecks.map(m => m.assignedDeck);
  } else if (gameType === 'deck') {
    const deckMatches = await db.all('SELECT DISTINCT deckNormalizedName FROM deck_matches WHERE gameId = ?', gameId);
    deckNames = deckMatches.map(m => m.deckNormalizedName);
    
    // Also get any assigned players from deck matches
    const assignedPlayers = await db.all('SELECT DISTINCT assignedPlayer FROM deck_matches WHERE gameId = ? AND assignedPlayer IS NOT NULL', gameId);
    playerIds = assignedPlayers.map(m => m.assignedPlayer);
  }

  return { playerIds, deckNames };
}

async function createDetailedSnapshot(gameId: string): Promise<MatchSnapshot | null> {
  try {
    const gameType = await getGameType(gameId);
    if (!gameType) {
      console.log(`[UNDO] Could not determine game type for ${gameId}`);
      return null;
    }

    const gameDetails = await getGameDetails(gameId);
    if (!gameDetails || gameDetails.status !== 'confirmed') {
      console.log(`[UNDO] Game ${gameId} not found or not confirmed`);
      return null;
    }

    let matches: any[] = [];
    if (gameType === 'player') {
      matches = await getMatchesByGameId(gameId);
    } else {
      matches = await getDeckMatchesByGameId(gameId);
    }

    if (matches.length === 0) {
      console.log(`[UNDO] No matches found for game ${gameId}`);
      return null;
    }

    const snapshot = await createSnapshotFromCurrentState(gameId, gameType, matches);
    console.log(`[UNDO] Created detailed snapshot for ${gameType} game ${gameId} with ${matches.length} matches`);
    
    return snapshot;
  } catch (error) {
    console.error(`[UNDO] Error creating detailed snapshot for game ${gameId}:`, error);
    return null;
  }
}

async function logUndoOperation(
  undoneSnapshots: UniversalSnapshot[], 
  adminUserId: string,
  operationType: 'single' | 'multiple'
): Promise<void> {
  console.log(`[UNDO] ${operationType} undo operation by admin ${adminUserId}:`);
  
  for (const snapshot of undoneSnapshots) {
    if (snapshot.gameType === 'set_command') {
      const setSnapshot = snapshot as SetCommandSnapshot;
      console.log(`  - Set command: ${setSnapshot.operationType} for ${setSnapshot.targetType} ${setSnapshot.targetId}`);
    } else {
      const matchSnapshot = snapshot as MatchSnapshot;
      const playerCount = matchSnapshot.before.filter(s => 'userId' in s).length;
      const deckCount = matchSnapshot.before.filter(s => 'normalizedName' in s).length;
      console.log(`  - ${matchSnapshot.gameType} game ${matchSnapshot.gameId}: ${playerCount} players, ${deckCount} decks`);
    }
  }
}

// Enhanced error handling and validation
async function validateUndoOperation(gameId?: string): Promise<{
  isValid: boolean,
  error?: string
}> {
  if (gameId) {
    const gameExists = await validateGameExists(gameId);
    if (!gameExists) {
      return {
        isValid: false,
        error: `Game ID "${gameId}" not found or already undone.`
      };
    }

    // Check if the game is in the operation stack
    const operation = findOperationByGameId(gameId);
    if (!operation) {
      return {
        isValid: false,
        error: `Game ID "${gameId}" not found in operation stack. Only recent operations can be undone.`
      };
    }
  }

  return { isValid: true };
}

// Enhanced cleanup and maintenance
async function performPostUndoMaintenance(): Promise<{
  playersRemoved: number,
  decksRemoved: number,
  entitiesUpdated: number
}> {
  console.log('[UNDO] Starting post-undo maintenance...');
  
  const playerCleanup = await cleanupZeroPlayers();
  const deckCleanup = await cleanupZeroDecks();
  
  // Additional maintenance: ensure data consistency
  const db = getDatabase();
  
  // Clean up any orphaned player deck assignments
  await db.run(`
    DELETE FROM player_deck_assignments 
    WHERE gameId NOT IN (SELECT gameId FROM games_master WHERE status = 'confirmed')
  `);
  
  // Update any deck assignments that might be inconsistent
  const inconsistentAssignments = await db.all(`
    SELECT COUNT(*) as count FROM matches m
    LEFT JOIN decks d ON m.assignedDeck = d.normalizedName
    WHERE m.assignedDeck IS NOT NULL AND d.normalizedName IS NULL
  `);
  
  console.log(`[UNDO] Maintenance completed. Players removed: ${playerCleanup.cleanedPlayers}, Decks removed: ${deckCleanup.cleanedDecks}`);
  
  return {
    playersRemoved: playerCleanup.cleanedPlayers,
    decksRemoved: deckCleanup.cleanedDecks,
    entitiesUpdated: inconsistentAssignments[0]?.count || 0
  };
}

// Export additional functions for testing and debugging
export async function debugUndoStack(): Promise<any> {
  const { getAllActiveOperations, getAllUndoneOperations, getStackInfo } = await import('../utils/snapshot-utils.js');
  
  return {
    stackInfo: getStackInfo(),
    activeOperations: getAllActiveOperations().map(op => ({
      gameId: op.gameId,
      gameType: op.gameType,
      timestamp: op.timestamp,
      description: 'description' in op ? op.description : `${op.gameType} game`
    })),
    undoneOperations: getAllUndoneOperations().map(op => ({
      gameId: op.gameId,
      gameType: op.gameType,
      timestamp: op.timestamp,
      description: 'description' in op ? op.description : `${op.gameType} game`
    }))
  };
}