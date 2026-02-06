import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder 
} from 'discord.js';
import { config } from '../config.js';
import {
  redoLastOperation,
  getPlayerSnapshotDiffs,
  getDeckSnapshotDiffs,
  MatchSnapshot,
  PlayerSnapshot,
  DeckSnapshot,
  UniversalSnapshot,
  SetCommandSnapshot,
  DecaySnapshot
} from '../utils/snapshot-utils.js';
import { updatePlayerRating, getOrCreatePlayer } from '../db/player-utils.js';
import { updateDeckRating, getOrCreateDeck } from '../db/deck-utils.js';
import { calculateElo } from '../utils/elo-utils.js';
import { getDatabase } from '../db/init.js';
import { logRatingChange } from '../utils/rating-audit-utils.js';
import { 
  cleanupZeroPlayers,
  cleanupZeroDecks
} from '../db/database-utils.js';

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('redo')
  .setDescription('Restore the most recently undone operation');

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const isAdmin = hasModAccess(userId);

  if (!isAdmin) {
    await interaction.reply({
      content: 'Only administrators can redo operations.',
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Use snapshot system to redo last undone operation
    const redoneSnapshot = await redoLastOperation();
    
    if (!redoneSnapshot) {
      await interaction.editReply({
        content: 'No undone operations found to redo.'
      });
      return;
    }

    // Handle restoration based on snapshot type
    if (redoneSnapshot.gameType === 'set_command') {
      // Set command redo is handled internally by redoLastOperation()
      // Log the restoration for audit purposes
      await logSetCommandRedo(redoneSnapshot as SetCommandSnapshot, userId);
    } else if (redoneSnapshot.gameType === 'decay') {
      // Decay redo is handled internally by redoLastOperation()
      // Just log for audit purposes
      console.log(`[REDO] Restored decay cycle affecting ${(redoneSnapshot as DecaySnapshot).players.length} players`);
    } else {
      // Restore ratings to after-game state and restore game to database
      const gameSnapshot = redoneSnapshot as MatchSnapshot;
      await restoreRatingsFromSnapshot(gameSnapshot, userId);
      await restoreGameToDatabase(gameSnapshot);
    }

    // Create response embed
    const embed = await createRedoEmbed(redoneSnapshot, interaction);
    await interaction.editReply({ embeds: [embed] });

    // Cleanup players/decks with 0/0/0 records in active games
    // This ensures consistency after any operation
    const playerCleanup = await cleanupZeroPlayers();
    const deckCleanup = await cleanupZeroDecks();

    if (playerCleanup.cleanedPlayers > 0 || deckCleanup.cleanedDecks > 0) {
      await interaction.followUp({
        content: `Cleanup: Removed ${playerCleanup.cleanedPlayers} players and ${deckCleanup.cleanedDecks} decks with 0/0/0 records.`,
        ephemeral: true
      });
    }

  } catch (error) {
    console.error('Error redoing operation:', error);
    await interaction.editReply({
      content: 'An error occurred while redoing the operation.'
    });
  }
}

async function logSetCommandRedo(snapshot: SetCommandSnapshot, adminUserId: string): Promise<void> {
  // Log the restoration for audit purposes
  if (snapshot.operationType === 'rating_change') {
    await logRatingChange({
      targetType: snapshot.targetType as 'player' | 'deck',
      targetId: snapshot.targetId,
      targetDisplayName: snapshot.description,
      changeType: 'redo',
      adminUserId,
      oldMu: snapshot.before.mu!,
      oldSigma: snapshot.before.sigma!,
      oldElo: calculateElo(snapshot.before.mu!, snapshot.before.sigma!),
      newMu: snapshot.after.mu!,
      newSigma: snapshot.after.sigma!,
      newElo: calculateElo(snapshot.after.mu!, snapshot.after.sigma!),
      oldWins: snapshot.before.wins!,
      oldLosses: snapshot.before.losses!,
      oldDraws: snapshot.before.draws!,
      newWins: snapshot.after.wins!,
      newLosses: snapshot.after.losses!,
      newDraws: snapshot.after.draws!,
      reason: `Redo ${snapshot.operationType} for ${snapshot.targetType} ${snapshot.targetId}`
    });
  }
}

async function restoreRatingsFromSnapshot(snapshot: MatchSnapshot, adminUserId: string): Promise<void> {
  const db = getDatabase();

  // Restore player ratings to after-game state
  const playerAfter = snapshot.after.filter(s => 'userId' in s) as PlayerSnapshot[];
  for (const playerSnapshot of playerAfter) {
    // Ensure player exists first (may have been cleaned up after undo)
    await getOrCreatePlayer(playerSnapshot.userId);

    await updatePlayerRating(
      playerSnapshot.userId,
      playerSnapshot.mu,
      playerSnapshot.sigma,
      playerSnapshot.wins,
      playerSnapshot.losses,
      playerSnapshot.draws
    );

    // Restore lastPlayed to the game's timestamp (updatePlayerRating resets it to "now")
    if (playerSnapshot.lastPlayed !== undefined) {
      await db.run('UPDATE players SET lastPlayed = ? WHERE userId = ?', [playerSnapshot.lastPlayed, playerSnapshot.userId]);
    }

    // Log the restoration
    const beforeSnapshot = snapshot.before.find(s => 'userId' in s && s.userId === playerSnapshot.userId) as PlayerSnapshot;
    if (beforeSnapshot) {
      await logRatingChange({
        targetType: 'player',
        targetId: playerSnapshot.userId,
        targetDisplayName: playerSnapshot.tag,
        changeType: 'redo',
        adminUserId,
        oldMu: beforeSnapshot.mu,
        oldSigma: beforeSnapshot.sigma,
        oldElo: calculateElo(beforeSnapshot.mu, beforeSnapshot.sigma),
        newMu: playerSnapshot.mu,
        newSigma: playerSnapshot.sigma,
        newElo: calculateElo(playerSnapshot.mu, playerSnapshot.sigma),
        oldWins: beforeSnapshot.wins,
        oldLosses: beforeSnapshot.losses,
        oldDraws: beforeSnapshot.draws,
        newWins: playerSnapshot.wins,
        newLosses: playerSnapshot.losses,
        newDraws: playerSnapshot.draws,
        reason: `Redo ${snapshot.gameType} game ${snapshot.gameId}`
      });
    }
  }

  // Restore deck ratings to after-game state
  const deckAfter = snapshot.after.filter(s => 'normalizedName' in s) as DeckSnapshot[];
  for (const deckSnapshot of deckAfter) {
    // Ensure deck exists first (may have been cleaned up after undo)
    await getOrCreateDeck(deckSnapshot.normalizedName, deckSnapshot.displayName);

    await updateDeckRating(
      deckSnapshot.normalizedName,
      deckSnapshot.displayName,
      deckSnapshot.mu,
      deckSnapshot.sigma,
      deckSnapshot.wins,
      deckSnapshot.losses,
      deckSnapshot.draws
    );

    // Log the restoration
    const beforeSnapshot = snapshot.before.find(s => 'normalizedName' in s && s.normalizedName === deckSnapshot.normalizedName) as DeckSnapshot;
    if (beforeSnapshot) {
      await logRatingChange({
        targetType: 'deck',
        targetId: deckSnapshot.normalizedName,
        targetDisplayName: deckSnapshot.displayName,
        changeType: 'redo',
        adminUserId,
        oldMu: beforeSnapshot.mu,
        oldSigma: beforeSnapshot.sigma,
        oldElo: calculateElo(beforeSnapshot.mu, beforeSnapshot.sigma),
        newMu: deckSnapshot.mu,
        newSigma: deckSnapshot.sigma,
        newElo: calculateElo(deckSnapshot.mu, deckSnapshot.sigma),
        oldWins: beforeSnapshot.wins,
        oldLosses: beforeSnapshot.losses,
        oldDraws: beforeSnapshot.draws,
        newWins: deckSnapshot.wins,
        newLosses: deckSnapshot.losses,
        newDraws: deckSnapshot.draws,
        reason: `Redo ${snapshot.gameType} game ${snapshot.gameId}`
      });
    }
  }
}

async function restoreGameToDatabase(snapshot: MatchSnapshot): Promise<void> {
  const db = getDatabase();
  try {
    // First check if games_master entry exists, if not restore it
    const existingGame = await db.get('SELECT gameId FROM games_master WHERE gameId = ?', snapshot.gameId);
    if (!existingGame) {
      // Extract game info from snapshot matchData if available
      const sampleMatch = snapshot.matchData[0];
      const submittedBy = sampleMatch?.submittedBy || 'unknown';
      const submittedByAdmin = sampleMatch?.submittedByAdmin || false;
      
      await db.run(`
        INSERT INTO games_master (gameId, gameSequence, gameType, submittedBy, submittedByAdmin, status, createdAt)
        VALUES (?, ?, ?, ?, ?, 'confirmed', datetime('now'))
      `, [snapshot.gameId, snapshot.gameSequence, snapshot.gameType, submittedBy, submittedByAdmin ? 1 : 0]);
    } else {
      // Just update status if it exists
      await db.run('UPDATE games_master SET status = ? WHERE gameId = ?', ['confirmed', snapshot.gameId]);
    }

    // Check if game_ids entry exists, if not restore it
    const existingGameId = await db.get('SELECT gameId FROM game_ids WHERE gameId = ?', snapshot.gameId);
    if (!existingGameId) {
      await db.run(`
        INSERT INTO game_ids (gameId, gameType, gameSequence, status)
        VALUES (?, ?, ?, 'confirmed')
      `, [snapshot.gameId, snapshot.gameType, snapshot.gameSequence]);
    } else {
      await db.run('UPDATE game_ids SET status = ?, gameSequence = ? WHERE gameId = ?', 
        ['confirmed', snapshot.gameSequence, snapshot.gameId]);
    }

    // Mark as confirmed in games_master and game_ids
    await db.run('UPDATE games_master SET status = ? WHERE gameId = ?', ['confirmed', snapshot.gameId]);
    await db.run('UPDATE game_ids SET status = ? WHERE gameId = ?', ['confirmed', snapshot.gameId]);

    // Check if this is a hybrid game by looking at snapshot data
    const hasPlayerData = snapshot.matchData.some(match => match.userId);
    const hasDeckData = snapshot.matchData.some(match => match.deckNormalizedName);

    // Restore the actual match/deck_match data using the ORIGINAL game ID from snapshot
    if (hasPlayerData) {
      // Restore player matches
      const playerMatches = snapshot.matchData.filter(match => match.userId);
      for (const matchData of playerMatches) {
        await db.run(`
          INSERT OR REPLACE INTO matches (
            id, gameId, userId, status, matchDate, mu, sigma, teams, scores, score, 
            submittedByAdmin, turnOrder, gameSequence, assignedDeck
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          matchData.id, 
          snapshot.gameId,  // Use snapshot.gameId, not matchData.gameId
          matchData.userId, 
          matchData.status, 
          matchData.matchDate || new Date().toISOString(), 
          matchData.mu, 
          matchData.sigma, 
          matchData.teams || null, 
          matchData.scores || null, 
          matchData.score || 0, 
          matchData.submittedByAdmin || false, 
          matchData.turnOrder || null, 
          snapshot.gameSequence,  // Use snapshot.gameSequence for consistency
          matchData.assignedDeck || null
        ]);
      }
    }

    if (hasDeckData) {
      // Restore deck matches
      const deckMatches = snapshot.matchData.filter(match => match.deckNormalizedName);
      for (const matchData of deckMatches) {
        await db.run(`
          INSERT OR REPLACE INTO deck_matches (
            id, gameId, deckNormalizedName, deckDisplayName, status, matchDate, 
            mu, sigma, turnOrder, gameSequence, submittedByAdmin, assignedPlayer
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          matchData.id, 
          snapshot.gameId,  // Use snapshot.gameId, not matchData.gameId
          matchData.deckNormalizedName, 
          matchData.deckDisplayName, 
          matchData.status, 
          matchData.matchDate || new Date().toISOString(), 
          matchData.mu, 
          matchData.sigma, 
          matchData.turnOrder || null, 
          snapshot.gameSequence,  // Use snapshot.gameSequence for consistency
          matchData.submittedByAdmin || false,
          matchData.assignedPlayer || null
        ]);
      }
    }

    console.log(`[REDO] Restored ${snapshot.gameType} game ${snapshot.gameId} to database (has player data: ${hasPlayerData}, has deck data: ${hasDeckData})`);
  } catch (error) {
    console.error(`[REDO] Error restoring game ${snapshot.gameId}:`, error);
    throw error;
  }
}

async function createRedoEmbed(snapshot: UniversalSnapshot, interaction: ChatInputCommandInteraction): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder()
    .setTitle('Operation Restored')
    .setColor(0x00AE86)
    .setTimestamp();

  if (snapshot.gameType === 'set_command') {
    const setSnapshot = snapshot as SetCommandSnapshot;
    embed.setDescription(`Successfully restored **${setSnapshot.operationType}**: **${setSnapshot.description}**`);

    // Show what was restored
    let changesSummary = '';
    if (setSnapshot.operationType === 'rating_change') {
      const oldElo = calculateElo(setSnapshot.before.mu!, setSnapshot.before.sigma!);
      const newElo = calculateElo(setSnapshot.after.mu!, setSnapshot.after.sigma!);
      changesSummary = `Elo: ${oldElo.toFixed(0)} → ${newElo.toFixed(0)}`;

      if (setSnapshot.before.wins !== setSnapshot.after.wins) {
        changesSummary += `\nW/L/D: ${setSnapshot.before.wins}/${setSnapshot.before.losses}/${setSnapshot.before.draws} → ${setSnapshot.after.wins}/${setSnapshot.after.losses}/${setSnapshot.after.draws}`;
      }
    } else if (setSnapshot.operationType === 'deck_assignment') {
      const oldDeck = setSnapshot.before.defaultDeck || 'None';
      const newDeck = setSnapshot.after.defaultDeck || 'None';
      changesSummary = `Default Deck: ${oldDeck} → ${newDeck}`;
      if (setSnapshot.after.matchAssignments && setSnapshot.after.matchAssignments.length > 0) {
        const gamesAffected = setSnapshot.after.matchAssignments.filter(
          (ma, i) => ma.assignedDeck !== setSnapshot.before.matchAssignments?.[i]?.assignedDeck
        ).length;
        if (gamesAffected > 0) {
          changesSummary += `\nCommander assignments changed in ${gamesAffected} game(s)`;
        }
      }
      if (setSnapshot.after.needsRecalculation) {
        changesSummary += '\nFull rating recalculation applied';
      }
    } else if (setSnapshot.operationType === 'game_modification') {
      const oldActive = setSnapshot.before.active ? 'Active' : 'Inactive';
      const newActive = setSnapshot.after.active ? 'Active' : 'Inactive';
      changesSummary = `Game Status: ${oldActive} → ${newActive}`;
      if (setSnapshot.after.matchRecords) {
        changesSummary += `\nMatch records restored (${setSnapshot.after.matchRecords.length} player(s))`;
      }
      if (setSnapshot.after.deckMatchRecords && setSnapshot.after.deckMatchRecords.length > 0) {
        changesSummary += `\nDeck match records restored (${setSnapshot.after.deckMatchRecords.length} deck(s))`;
      }
      changesSummary += '\nFull rating recalculation applied';
    } else if (setSnapshot.operationType === 'turn_order' || setSnapshot.operationType === 'turn_order_removal') {
      const oldOrder = setSnapshot.before.turnOrder ?? 'None';
      const newOrder = setSnapshot.after.turnOrder ?? 'None';
      changesSummary = `Turn Order: ${oldOrder} → ${newOrder}`;
    } else if (setSnapshot.operationType === 'bulk_turn_order_removal') {
      const gameCount = setSnapshot.before.gamesWithTurnOrder?.length || 0;
      changesSummary = `Removed turn order assignments from ${gameCount} game(s)`;
    }

    if (changesSummary) {
      embed.addFields({
        name: 'Changes Restored',
        value: changesSummary,
        inline: false
      });
    }

    return embed;
  } else if (snapshot.gameType === 'decay') {
    const decaySnapshot = snapshot as DecaySnapshot;
    embed.setDescription(`Successfully restored **Decay Cycle**: ${decaySnapshot.description}`);

    // Show affected players
    let playerSummary = '';
    for (const player of decaySnapshot.players.slice(0, 10)) {
      const beforeElo = calculateElo(player.beforeMu, player.beforeSigma);
      const afterElo = calculateElo(player.afterMu, player.afterSigma);
      try {
        const user = await interaction.client.users.fetch(player.userId);
        playerSummary += `@${user.username}: ${beforeElo} → ${afterElo} Elo (decay re-applied)\n`;
      } catch {
        playerSummary += `<@${player.userId}>: ${beforeElo} → ${afterElo} Elo (decay re-applied)\n`;
      }
    }

    if (decaySnapshot.players.length > 10) {
      playerSummary += `... and ${decaySnapshot.players.length - 10} more players`;
    }

    if (playerSummary) {
      embed.addFields({
        name: 'Players Affected',
        value: playerSummary.trim(),
        inline: false
      });
    }

    const triggeredByText = decaySnapshot.metadata.triggeredBy === 'timewalk'
      ? `/timewalk${decaySnapshot.metadata.simulatedDaysOffset ? ` (+${decaySnapshot.metadata.simulatedDaysOffset} days)` : ''}`
      : 'Scheduled (midnight)';
    embed.addFields({
      name: 'Decay Details',
      value: `Triggered by: ${triggeredByText}\nGrace period: ${decaySnapshot.metadata.graceDays} days\nDecay amount: -${decaySnapshot.metadata.decayAmount} Elo/day`,
      inline: false
    });

    return embed;
  } else {
    const gameSnapshot = snapshot as MatchSnapshot;
    
    // Simple game type determination - either 'player' or 'deck'
    const gameTypeDescription = gameSnapshot.gameType === 'player' ? 'Player' : 'Deck';
    
    embed.setDescription(`Successfully restored **${gameTypeDescription}** game: **${gameSnapshot.gameId}**`);

    // Add player diffs if any
    const playerBefore = gameSnapshot.before.filter(s => 'userId' in s) as PlayerSnapshot[];
    const playerAfter = gameSnapshot.after.filter(s => 'userId' in s) as PlayerSnapshot[];
    
    if (playerBefore.length > 0) {
      const playerDiffs = getPlayerSnapshotDiffs(playerBefore, playerAfter);
      
      let playerSummary = '';
      for (let i = 0; i < Math.min(6, playerDiffs.length); i++) {
        const diff = playerDiffs[i];
        const player = playerBefore[i];
        try {
          // Try to get Discord username
          const user = await interaction.client.users.fetch(player.userId);
          const turnOrder = player.turnOrder ? ` [Turn ${player.turnOrder}]` : '';
          const commander = player.commander ? ` [${player.commander}]` : '';
          playerSummary += `@${user.username}${turnOrder}${commander}: ${diff.beforeElo} → ${diff.afterElo} Elo (${diff.beforeW}/${diff.beforeL}/${diff.beforeD} → ${diff.afterW}/${diff.afterL}/${diff.afterD})\n`;
        } catch {
          // Fallback to user ID
          const turnOrder = player.turnOrder ? ` [Turn ${player.turnOrder}]` : '';
          const commander = player.commander ? ` [${player.commander}]` : '';
          playerSummary += `<@${player.userId}>${turnOrder}${commander}: ${diff.beforeElo} → ${diff.afterElo} Elo (${diff.beforeW}/${diff.beforeL}/${diff.beforeD} → ${diff.afterW}/${diff.afterL}/${diff.afterD})\n`;
        }
      }
      
      const moreText = playerDiffs.length > 6 ? `... and ${playerDiffs.length - 6} more` : '';
      
      embed.addFields({
        name: 'Player Changes',
        value: playerSummary + moreText || 'No player changes',
        inline: false
      });
    }

    // Add deck diffs if any
    const deckBefore = gameSnapshot.before.filter(s => 'normalizedName' in s) as DeckSnapshot[];
    const deckAfter = gameSnapshot.after.filter(s => 'normalizedName' in s) as DeckSnapshot[];
    
    if (deckBefore.length > 0) {
      const deckDiffs = getDeckSnapshotDiffs(deckBefore, deckAfter);
      const deckSummary = deckDiffs.slice(0, 6).map(diff => {
        const deck = deckBefore.find(d => d.displayName === diff.displayName);
        const turnOrder = deck?.turnOrder ? ` [Turn ${deck.turnOrder}]` : '';
        return `${diff.displayName}${turnOrder}: ${diff.beforeElo} → ${diff.afterElo} Elo (${diff.beforeW}/${diff.beforeL}/${diff.beforeD} → ${diff.afterW}/${diff.afterL}/${diff.afterD})`;
      }).join('\n');
      
      const moreText = deckDiffs.length > 6 ? `\n... and ${deckDiffs.length - 6} more` : '';
      
      embed.addFields({
        name: 'Deck Changes',
        value: deckSummary + moreText || 'No deck changes',
        inline: false
      });
    }

    return embed;
  }
}