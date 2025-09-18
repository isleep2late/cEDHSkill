﻿import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder, 
  User 
} from 'discord.js';
import { getOrCreatePlayer, updatePlayerRating, getAllPlayers } from '../db/player-utils.js';
import { getOrCreateDeck, updateDeckRating, getAllDecks } from '../db/deck-utils.js';
import { calculateElo } from '../utils/elo-utils.js';
import { config } from '../config.js';
import { getDatabase } from '../db/init.js'; 
import { logRatingChange } from '../utils/rating-audit-utils.js'; 
import { normalizeCommanderName, validateCommander } from '../utils/edhrec-utils.js';
import { saveOperationSnapshot, SetCommandSnapshot } from '../utils/snapshot-utils.js';

export const data = new SlashCommandBuilder()
  .setName('set')
  .setDescription('Set game results, deck assignments, turn order, or ratings (admin only)')
  .addStringOption(option =>
    option.setName('target')
      .setDescription('Target: @user for player settings, gameId for game modifications, or commander name for deck ratings')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('deck')
      .setDescription('Commander name to assign (use "nocommander" to remove assignment)')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('gameid')
      .setDescription('Game ID for specific assignment, or "allgames" for all past/future games')
      .setRequired(false)
  )
  .addIntegerOption(option =>
    option.setName('turnorder')
      .setDescription('Turn order (1-4) for the specified game, or 0 to remove turn order assignment')
      .setRequired(false)
      .setMinValue(0) 
      .setMaxValue(4)
  )
  .addNumberOption(option =>
    option.setName('mu')
      .setDescription('(Admin only) Set mu rating')
      .setRequired(false)
  )
  .addNumberOption(option =>
    option.setName('sigma')
      .setDescription('(Admin only) Set sigma rating')
      .setRequired(false)
  )
  .addIntegerOption(option =>
    option.setName('elo')
      .setDescription('(Admin only) Set Elo rating')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('wld')
      .setDescription('(Admin only) Set W/L/D record (format: wins/losses/draws)')
      .setRequired(false)
  )
  .addBooleanOption(option =>
    option.setName('active')
      .setDescription('(Admin only) Set game active status (true/false)')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('results')
      .setDescription('(Admin only) Set game results: "@user1 w @user2 l" or "commander1 w commander2 l"')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const requesterId = interaction.user.id;
  const target = interaction.options.getString('target');
  const deckName = interaction.options.getString('deck');
  const gameId = interaction.options.getString('gameid');
  const turnOrder = interaction.options.getInteger('turnorder');
  const mu = interaction.options.getNumber('mu');
  const sigma = interaction.options.getNumber('sigma');
  const elo = interaction.options.getInteger('elo');
  const wldString = interaction.options.getString('wld');
  const active = interaction.options.getBoolean('active');
  const results = interaction.options.getString('results');
  
  const isAdmin = config.admins.includes(requesterId);

  // Check for admin-only parameters first
  const adminOnlyParams = [mu, sigma, elo, wldString, active, results].some(param => param !== null);
  const targetingOtherUser = target && target.match(/<@!?(\d+)>/) && target.replace(/\D/g, '') !== interaction.user.id;
  const hasAdminOnlyTarget = target && (await isGameId(target) || (!target.match(/<@!?(\d+)>/) && (mu !== null || sigma !== null || elo !== null || wldString)));

  if ((adminOnlyParams || hasAdminOnlyTarget) && !isAdmin) {
    await interaction.reply({
      content: 'Only admins can modify other users, ratings, game results, or commander ratings.',
      ephemeral: true
    });
    return;
  }

  // Input validation
  if (!target && !deckName && !gameId && turnOrder === null && mu === null && sigma === null && elo === null && !wldString && active === null && !results) {
    await interaction.reply({
      content: 'You must specify at least one parameter to set.',
      ephemeral: true
    });
    return;
  }

  try {
  // Determine the operation type based on parameters
  
  // Check if this is a game modification (admin only)
  // FIXED: Also check if gameId is provided with active/results parameters
  if ((target && await isGameId(target)) || results || (gameId && (active !== null || results))) {
    if (!isAdmin) {
      await interaction.reply({
        content: 'Only admins can modify game results.',
        ephemeral: true
      });
      return;
    }
    // Use gameId parameter if target is not provided, otherwise use target
    const targetGameId = target || gameId;
    await handleGameModification(interaction, targetGameId, results, active, requesterId);
    return;
  }

  // Check if this is a player modification
  if (target && target.match(/<@!?(\d+)>/)) {
    const userId = target.replace(/\D/g, '');
    
    // For non-admins, only allow self-modification and only deck/turn order
    if (!isAdmin) {
      if (userId !== requesterId) {
        await interaction.reply({
          content: 'You can only modify your own settings.',
          ephemeral: true
        });
        return;
      }
      
      // Check if user is trying to assign to a game they're not in (unless turn order is 0)
      if (gameId && gameId !== 'allgames' && turnOrder !== 0) {
        const isInGame = await checkUserInGame(userId, gameId);
        if (!isInGame) {
          await interaction.reply({
            content: 'You can only assign decks or turn order to games you are participating in.',
            ephemeral: true
          });
          return;
        }
      }
    }
    
    await handlePlayerModification(interaction, userId, deckName, gameId, turnOrder, mu, sigma, elo, wldString, requesterId);
    return;
  }

  // Check if this is a commander rating modification (admin only)
  if (target && !target.match(/<@!?(\d+)>/) && (mu !== null || sigma !== null || elo !== null || wldString)) {
    if (!isAdmin) {
      await interaction.reply({
        content: 'Only admins can modify commander ratings.',
        ephemeral: true
      });
      return;
    }
    await handleCommanderRatingModification(interaction, target, mu, sigma, elo, wldString, requesterId);
    return;
  }

  // Handle self-assignments without target parameter
  if (!target && (deckName || (turnOrder !== null && gameId))) {
    // Check if user is trying to assign to a game they're not in (unless turn order is 0)
    if (gameId && gameId !== 'allgames' && turnOrder !== 0) {
      const isInGame = await checkUserInGame(requesterId, gameId);
      if (!isInGame) {
        await interaction.reply({
          content: 'You can only assign decks or turn order to games you are participating in.',
          ephemeral: true
        });
        return;
      }
    }
    
    await handlePlayerModification(interaction, requesterId, deckName, gameId, turnOrder, null, null, null, null, requesterId);
    return;
  }

  await interaction.reply({
    content: 'Invalid parameters. Use /set gameid:GAMEID active:false to deactivate a game, or /set deck:commander for your own settings.',
    ephemeral: true
  });

} catch (error) {
  console.error('Error in /set command:', error);
  await interaction.reply({
    content: 'An error occurred while updating settings.',
    ephemeral: true
  });
}
}

// ENHANCED: handleTurnOrderWithAdmin now supports turn order 0 for removal
async function handleTurnOrderWithAdmin(
  targetUserId: string,
  targetUser: User | null,
  gameId: string,
  turnOrder: number,
  adminId: string
): Promise<string> {
  const db = getDatabase();
  const displayName = targetUser?.displayName || targetUserId;
  
  // Get current turn order for snapshot
  const currentMatch = await db.get(`
    SELECT turnOrder FROM matches 
    WHERE userId = ? AND gameId = ?
  `, targetUserId, gameId);
  
  // ENHANCED: Handle turn order 0 (removal)
  if (turnOrder === 0) {
    // Create snapshot for turn order removal
    const snapshot: SetCommandSnapshot = {
      matchId: `set-${Date.now()}`,
      gameId: gameId,
      gameSequence: Date.now(),
      gameType: 'set_command',
      operationType: 'turn_order_removal',
      targetType: 'player',
      targetId: targetUserId,
      before: {
        turnOrder: currentMatch?.turnOrder || null
      },
      after: {
        turnOrder: null
      },
      metadata: {
        adminUserId: adminId,
        parameters: JSON.stringify({ gameId, turnOrder: 0 }),
        reason: 'Turn order removal via /set command'
      },
      timestamp: new Date().toISOString(),
      description: `Removed turn order for ${displayName} in game ${gameId}`
    };

    // Save snapshot before database changes
    saveOperationSnapshot(snapshot);
    
    // Remove turn order assignment (set to NULL)
    await db.run(`
      UPDATE matches 
      SET turnOrder = NULL 
      WHERE userId = ? AND gameId = ?
    `, targetUserId, gameId);
    
    return `Removed turn order assignment for ${displayName} in game ${gameId}`;
  }
  
  // Check if turn order is already taken by another player (for non-zero values)
  const existingTurnOrder = await db.get(`
    SELECT userId FROM matches 
    WHERE gameId = ? AND turnOrder = ? AND userId != ?
  `, gameId, turnOrder, targetUserId);
  
  if (existingTurnOrder) {
    throw new Error(`Turn order ${turnOrder} is already assigned to another player in game ${gameId}`);
  }
  
  // Create snapshot for turn order assignment
  const snapshot: SetCommandSnapshot = {
    matchId: `set-${Date.now()}`,
    gameId: gameId,
    gameSequence: Date.now(),
    gameType: 'set_command',
    operationType: 'turn_order',
    targetType: 'player',
    targetId: targetUserId,
    before: {
      turnOrder: currentMatch?.turnOrder || null
    },
    after: {
      turnOrder: turnOrder
    },
    metadata: {
      adminUserId: adminId,
      parameters: JSON.stringify({ gameId, turnOrder }),
      reason: 'Turn order assignment via /set command'
    },
    timestamp: new Date().toISOString(),
    description: `Set turn order ${turnOrder} for ${displayName} in game ${gameId}`
  };

  // Save snapshot before database changes
  saveOperationSnapshot(snapshot);
  
  // Set the new turn order
  await db.run(`
    UPDATE matches 
    SET turnOrder = ? 
    WHERE userId = ? AND gameId = ?
  `, turnOrder, targetUserId, gameId);
  
  return `Set turn order ${turnOrder} for ${displayName} in game ${gameId}`;
}

// ENHANCED: handlePlayerModification with turn order 0 support
async function handlePlayerModification(
  interaction: ChatInputCommandInteraction,
  userId: string,
  deckName: string | null,
  gameId: string | null,
  turnOrder: number | null,
  mu: number | null,
  sigma: number | null,
  elo: number | null,
  wldString: string | null,
  adminId: string
) {
  const db = getDatabase();
  const targetUser = await interaction.client.users.fetch(userId).catch(() => null);
  const displayName = targetUser?.displayName || userId;

  // Validate inputs
  if (turnOrder !== null && turnOrder !== 0 && !gameId) {
    await interaction.reply({
      content: 'Turn order requires a game ID (except when using 0 to remove assignments).',
      ephemeral: true
    });
    return;
  }

  if (gameId && gameId !== 'allgames' && !await gameExists(gameId)) {
    await interaction.reply({
      content: `Game ID "${gameId}" not found.`,
      ephemeral: true
    });
    return;
  }

  // Parse W/L/D if provided
  let wldRecord = null;
  if (wldString) {
    const wldMatch = wldString.match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!wldMatch) {
      await interaction.reply({
        content: 'W/L/D format must be "wins/losses/draws" (e.g., "10/5/2").',
        ephemeral: true
      });
      return;
    }
    wldRecord = {
      wins: parseInt(wldMatch[1]),
      losses: parseInt(wldMatch[2]),
      draws: parseInt(wldMatch[3])
    };
  }

  let results = [];

  // Handle rating changes
  if (mu !== null || sigma !== null || elo !== null || wldRecord) {
    const ratingResult = await handleRatingChanges(userId, targetUser, mu, sigma, elo, wldRecord, adminId);
    results.push(ratingResult);
  }

  // Handle deck assignments
  if (deckName) {
    const deckResult = await handleDeckAssignment(userId, targetUser, deckName, gameId, adminId);
    results.push(deckResult);
  }

  // ENHANCED: Handle turn order (including 0 for removal)
  if (turnOrder !== null && gameId && gameId !== 'allgames') {
    const turnResult = await handleTurnOrderWithAdmin(userId, targetUser, gameId, turnOrder, adminId);
    results.push(turnResult);
  } else if (turnOrder === 0 && !gameId) {
    // Special case: turn order 0 without game ID means remove from all games
    const allGameResult = await removeAllTurnOrderAssignments(userId, targetUser, adminId);
    results.push(allGameResult);
  }

  const embed = new EmbedBuilder()
    .setTitle('Player Settings Updated')
    .setDescription(results.join('\n\n'))
    .setColor(0x00AE86)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// NEW: Function to remove turn order assignments from all games
async function removeAllTurnOrderAssignments(
  targetUserId: string,
  targetUser: User | null,
  adminId: string
): Promise<string> {
  const db = getDatabase();
  const displayName = targetUser?.displayName || targetUserId;
  
  // Get all games where this user has turn order assignments
  const gamesWithTurnOrder = await db.all(`
    SELECT gameId, turnOrder FROM matches 
    WHERE userId = ? AND turnOrder IS NOT NULL
  `, targetUserId);
  
  if (gamesWithTurnOrder.length === 0) {
    return `No turn order assignments found for ${displayName}`;
  }
  
  // Create snapshot for bulk turn order removal
  const snapshot: SetCommandSnapshot = {
    matchId: `set-${Date.now()}`,
    gameId: 'bulk_operation',
    gameSequence: Date.now(),
    gameType: 'set_command',
    operationType: 'bulk_turn_order_removal',
    targetType: 'player',
    targetId: targetUserId,
    before: {
      gamesWithTurnOrder: gamesWithTurnOrder
    },
    after: {
      gamesWithTurnOrder: []
    },
    metadata: {
      adminUserId: adminId,
      parameters: JSON.stringify({ turnOrder: 0, gameId: 'all' }),
      reason: 'Bulk turn order removal via /set command'
    },
    timestamp: new Date().toISOString(),
    description: `Removed all turn order assignments for ${displayName}`
  };

  // Save snapshot before database changes
  saveOperationSnapshot(snapshot);
  
  // Remove all turn order assignments
  await db.run(`
    UPDATE matches 
    SET turnOrder = NULL 
    WHERE userId = ? AND turnOrder IS NOT NULL
  `, targetUserId);
  
  return `Removed turn order assignments from ${gamesWithTurnOrder.length} games for ${displayName}`;
}

async function checkUserInGame(userId: string, gameId: string): Promise<boolean> {
  const db = getDatabase();
  const match = await db.get('SELECT userId FROM matches WHERE userId = ? AND gameId = ?', userId, gameId);
  return !!match;
}

async function isGameId(target: string): Promise<boolean> {
  const db = getDatabase();
  const game = await db.get('SELECT gameId FROM games_master WHERE gameId = ?', target);
  return !!game;
}

async function handleGameModification(
  interaction: ChatInputCommandInteraction, 
  gameId: string | null, 
  results: string | null, 
  active: boolean | null, 
  adminId: string
) {
  const db = getDatabase();
  
  // If gameId is provided, use it. If results are provided without gameId, error
  if (!gameId && results) {
    await interaction.reply({
      content: 'Game ID is required when setting results.',
      ephemeral: true
    });
    return;
  }

  if (!gameId) {
    await interaction.reply({
      content: 'Game ID is required for game modifications.',
      ephemeral: true
    });
    return;
  }

  // Verify game exists
  const gameInfo = await db.get('SELECT * FROM games_master WHERE gameId = ?', gameId);
  if (!gameInfo) {
    await interaction.reply({
      content: `Game ID "${gameId}" not found.`,
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply();

  // Create snapshot before modification
  const snapshot = await createGameModificationSnapshot(gameId, adminId, gameInfo, active);

  const modifications = [];

  // Handle active status change
  if (active !== null) {
    await db.run('UPDATE games_master SET active = ? WHERE gameId = ?', [active ? 1 : 0, gameId]);
    await db.run('UPDATE game_ids SET active = ? WHERE gameId = ?', [active ? 1 : 0, gameId]);
    modifications.push(`Active status: ${active ? 'true' : 'false'}`);
  }

  // Handle results modification
  if (results) {
    await modifyGameResults(gameId, results, gameInfo.gameType, modifications);
  }

  // Save snapshot
  if (snapshot) {
    saveOperationSnapshot(snapshot);
  }

  // Recalculate all ratings if game was modified
  if (modifications.length > 0) {
    await recalculateAllRatingsFromSequence(gameInfo.gameSequence);
  }

  const embed = new EmbedBuilder()
    .setTitle('Game Modified')
    .setDescription(`**Game ID:** ${gameId}\n\n${modifications.join('\n')}`)
    .setColor(0x00AE86)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function modifyGameResults(gameId: string, results: string, gameType: string, modifications: string[]) {
  const db = getDatabase();

  // Parse results similar to /rank command
  const tokens = results.match(/<@!?\d+>|[wld]|[1-4]|\S+/gi) || [];
  
  // Check if this is player or deck modification
  const mentionTokens = tokens.filter(t => /^<@!?\d+>$/.test(t));
  const isPlayerGame = mentionTokens.length > 0;
  
  // Verify game type consistency
  if ((gameType === 'player' && !isPlayerGame) || (gameType === 'deck' && isPlayerGame)) {
    throw new Error('Cannot change game type (player to deck or vice versa)');
  }

  if (isPlayerGame) {
    await modifyPlayerGameResults(gameId, tokens, modifications);
  } else {
    await modifyDeckGameResults(gameId, tokens, modifications);
  }
}

async function modifyPlayerGameResults(gameId: string, tokens: string[], modifications: string[]) {
  const db = getDatabase();

  // Parse player entries
  const players: Array<{
  userId: string;
  turnOrder?: number;
  status?: string;
  commander?: string;
}> = [];
let current: {
  userId: string;
  turnOrder?: number;
  status?: string;
  commander?: string;
} | null = null;
  
  for (const token of tokens) {
    if (/^<@!?(\d+)>$/.test(token)) {
      if (current) players.push(current);
      current = { userId: token.replace(/\D/g, '') };
    } else if (current) {
      if (/^[1-4]$/.test(token)) {
        current.turnOrder = parseInt(token);
      } else if (/^[wld]$/i.test(token)) {
        current.status = token.toLowerCase();
      } else if (/^[a-zA-Z0-9-]+$/.test(token)) {
        current.commander = token;
      }
    }
  }
  if (current) players.push(current);

  // Update existing matches
  for (const player of players) {
    const updates = [];
    const params = [];

    if (player.status) {
      updates.push('status = ?');
      params.push(player.status);
    }
    if (player.turnOrder) {
      updates.push('turnOrder = ?');
      params.push(player.turnOrder);
    }
    if (player.commander) {
      updates.push('assignedDeck = ?');
      params.push(normalizeCommanderName(player.commander));
    }

    if (updates.length > 0) {
      params.push(player.userId, gameId);
      await db.run(
        `UPDATE matches SET ${updates.join(', ')} WHERE userId = ? AND gameId = ?`,
        params
      );
    }
  }

  modifications.push(`Modified ${players.length} player results`);
}

async function modifyDeckGameResults(gameId: string, tokens: string[], modifications: string[]) {
  const db = getDatabase();

  // Parse deck entries
  const decks = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const deckName = tokens[i];
    const result = tokens[i + 1]?.toLowerCase();
    
    if (deckName && ['w', 'l', 'd'].includes(result)) {
      decks.push({
        normalizedName: normalizeCommanderName(deckName),
        status: result
      });
    }
  }

  // Update existing deck matches
  for (let i = 0; i < decks.length; i++) {
    const deck = decks[i];
    await db.run(
      'UPDATE deck_matches SET status = ? WHERE gameId = ? AND deckNormalizedName = ? LIMIT 1',
      [deck.status, gameId, deck.normalizedName]
    );
  }

  modifications.push(`Modified ${decks.length} deck results`);
}

async function createGameModificationSnapshot(gameId: string, adminId: string, gameInfo: any, active: boolean | null): Promise<SetCommandSnapshot> {
  return {
    matchId: `set-game-${Date.now()}`,
    gameId: gameId,
    gameSequence: gameInfo.gameSequence,
    gameType: 'set_command',
    operationType: 'game_modification',
    targetType: 'game',
    targetId: gameId,
    before: {
      active: gameInfo.active === 1
    },
    after: {
      active: active !== null ? active : gameInfo.active === 1
    },
    metadata: {
      adminUserId: adminId,
      parameters: JSON.stringify({ gameId, active }),
      reason: 'Game modification via /set command'
    },
    timestamp: new Date().toISOString(),
    description: `Modified game ${gameId}`
  };
}

async function recalculateAllRatingsFromSequence(fromSequence: number) {
  console.log(`[SET] Starting comprehensive recalculation from sequence ${fromSequence}`);
  
  const db = getDatabase();

  // Step 1: Reset ALL entities to their state right before the modified game
  await resetAllEntitiesToStateBeforeSequence(fromSequence);

  // Step 2: Get all games from the modified sequence onwards (to re-execute them)
  const subsequentGames = await db.all(`
    SELECT gameId, gameSequence, gameType, createdAt
    FROM games_master 
    WHERE gameSequence >= ? AND status = 'confirmed' AND active = 1
    ORDER BY gameSequence ASC, createdAt ASC
  `, [fromSequence]);

  console.log(`[SET] Re-executing ${subsequentGames.length} games from sequence ${fromSequence} onwards with original outcomes...`);

  // Step 3: Re-execute each subsequent game with its original outcomes but new rating calculations
  let processedGames = 0;
  for (const game of subsequentGames) {
    try {
      const playerMatches = await db.all('SELECT * FROM matches WHERE gameId = ?', game.gameId);
      const deckMatches = await db.all('SELECT * FROM deck_matches WHERE gameId = ?', game.gameId);

      if (playerMatches.length > 0) {
        await reexecutePlayerGameWithOriginalOutcome(game.gameId, playerMatches);
        console.log(`[SET] Re-executed player game ${game.gameId} (${processedGames + 1}/${subsequentGames.length})`);
      }
      
      if (deckMatches.length > 0) {
        await reexecuteDeckGameWithOriginalOutcome(game.gameId, deckMatches);
        console.log(`[SET] Re-executed deck game ${game.gameId} (${processedGames + 1}/${subsequentGames.length})`);
      }
      
      processedGames++;
    } catch (error) {
      console.error(`[SET] Error re-executing game ${game.gameId}:`, error);
    }
  }

  console.log(`[SET] Comprehensive recalculation completed. Re-executed ${processedGames} games from sequence ${fromSequence}.`);
}

async function resetAllEntitiesToStateBeforeSequence(beforeSequence: number): Promise<void> {
  const db = getDatabase();
  
  console.log(`[SET] Resetting ALL entities to their state before sequence ${beforeSequence}...`);

  // Get all players and reset them to their state before the modified game
  const allPlayers = await db.all('SELECT userId FROM players');
  for (const player of allPlayers) {
    const playerStateBefore = await getPlayerStateBeforeSequence(player.userId, beforeSequence);
    await updatePlayerRating(
      player.userId,
      playerStateBefore.mu,
      playerStateBefore.sigma,
      playerStateBefore.wins,
      playerStateBefore.losses,
      playerStateBefore.draws
    );
  }

  // Get all decks and reset them to their state before the modified game
  const allDecks = await db.all('SELECT normalizedName, displayName FROM decks');
  for (const deck of allDecks) {
    const deckStateBefore = await getDeckStateBeforeSequence(deck.normalizedName, beforeSequence);
    await updateDeckRating(
      deck.normalizedName,
      deckStateBefore.displayName,
      deckStateBefore.mu,
      deckStateBefore.sigma,
      deckStateBefore.wins,
      deckStateBefore.losses,
      deckStateBefore.draws
    );
  }

  console.log(`[SET] Reset ${allPlayers.length} players and ${allDecks.length} decks to pre-sequence ${beforeSequence} state`);
}

async function reexecutePlayerGameWithOriginalOutcome(gameId: string, originalMatches: any[]): Promise<void> {
  const db = getDatabase();
  
  if (originalMatches.length === 0) return;

  // Get current ratings for all players (after previous re-executions)
  const playerRatings: Record<string, any> = {};
  const playerStats: Record<string, any> = {};
  
  for (const match of originalMatches) {
    const player = await getOrCreatePlayer(match.userId);
    const { rating } = await import('openskill');
    playerRatings[match.userId] = rating({ mu: player.mu, sigma: player.sigma });
    playerStats[match.userId] = {
      wins: player.wins,
      losses: player.losses,
      draws: player.draws
    };
  }

  // Apply OpenSkill using the ORIGINAL outcomes (same winners/losers as before)
  const { rate } = await import('openskill');
  const gameRatings = originalMatches.map(match => [playerRatings[match.userId]]);
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = originalMatches.map(match => statusRank[match.status] || 3);
  const newRatings = rate(gameRatings, { rank: ranks });

  // Apply penalties and minimum changes
  const penalty = originalMatches.length === 3 ? 0.9 : 1.0;

  for (let i = 0; i < originalMatches.length; i++) {
    const match = originalMatches[i];
    const newRating = newRatings[i][0];
    
    const finalRating = {
      mu: 25 + (newRating.mu - 25) * penalty,
      sigma: newRating.sigma
    };

    const oldRating = playerRatings[match.userId];
    const adjustedRating = ensureMinimumRatingChange(oldRating, finalRating, match.status);

    // Update stats based on ORIGINAL outcome
    const stats = playerStats[match.userId];
    if (match.status === 'w') stats.wins++;
    else if (match.status === 'l') stats.losses++;
    else if (match.status === 'd') stats.draws++;

    // Update the match record with new ratings but keep original outcome
    await db.run(`
      UPDATE matches 
      SET mu = ?, sigma = ? 
      WHERE gameId = ? AND userId = ?
    `, [adjustedRating.mu, adjustedRating.sigma, gameId, match.userId]);

    // Save to player record
    await updatePlayerRating(
      match.userId,
      adjustedRating.mu,
      adjustedRating.sigma,
      stats.wins,
      stats.losses,
      stats.draws
    );
  }
}

async function reexecuteDeckGameWithOriginalOutcome(gameId: string, originalMatches: any[]): Promise<void> {
  const db = getDatabase();
  
  if (originalMatches.length === 0) return;

  // Get current ratings for all unique decks (after previous re-executions)
  const uniqueDecks = new Set(originalMatches.map(m => m.deckNormalizedName));
  const deckRatings: Record<string, any> = {};
  const deckStats: Record<string, any> = {};
  
  for (const deckName of uniqueDecks) {
    const match = originalMatches.find(m => m.deckNormalizedName === deckName);
    const deck = await getOrCreateDeck(deckName, match.deckDisplayName);
    const { rating } = await import('openskill');
    deckRatings[deckName] = rating({ mu: deck.mu, sigma: deck.sigma });
    deckStats[deckName] = {
      wins: deck.wins,
      losses: deck.losses,
      draws: deck.draws,
      displayName: deck.displayName
    };
  }

  // Apply OpenSkill using the ORIGINAL outcomes
  const { rate } = await import('openskill');
  const gameRatings = originalMatches.map(match => [deckRatings[match.deckNormalizedName]]);
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = originalMatches.map(match => statusRank[match.status] || 3);
  const newRatings = rate(gameRatings, { rank: ranks });
  const penalty = originalMatches.length === 3 ? 0.9 : 1.0;

  // Aggregate changes for duplicate decks using ORIGINAL outcomes
  const deckChanges: Record<string, { newRating: any, statusUpdates: string[] }> = {};

  for (let i = 0; i < originalMatches.length; i++) {
    const match = originalMatches[i];
    const newRating = newRatings[i][0];
    
    const finalRating = {
      mu: 25 + (newRating.mu - 25) * penalty,
      sigma: newRating.sigma
    };

    if (!deckChanges[match.deckNormalizedName]) {
      deckChanges[match.deckNormalizedName] = {
        newRating: finalRating,
        statusUpdates: []
      };
    }

    // Keep ORIGINAL outcome
    deckChanges[match.deckNormalizedName].statusUpdates.push(match.status);
    deckChanges[match.deckNormalizedName].newRating = finalRating;
  }

  // Apply changes to unique decks
  for (const [deckName, changes] of Object.entries(deckChanges)) {
    const stats = deckStats[deckName];
    
    // Update stats based on ORIGINAL outcomes
    for (const status of changes.statusUpdates) {
      if (status === 'w') stats.wins++;
      else if (status === 'l') stats.losses++;
      else if (status === 'd') stats.draws++;
    }

    // Update match records with new ratings but keep original outcomes
    await db.run(`
      UPDATE deck_matches 
      SET mu = ?, sigma = ? 
      WHERE gameId = ? AND deckNormalizedName = ?
    `, [changes.newRating.mu, changes.newRating.sigma, gameId, deckName]);

    await updateDeckRating(
      deckName,
      stats.displayName,
      changes.newRating.mu,
      changes.newRating.sigma,
      stats.wins,
      stats.losses,
      stats.draws
    );
  }
}

async function getPlayerStateBeforeSequence(playerId: string, beforeSequence: number): Promise<{
  mu: number,
  sigma: number,
  wins: number,
  losses: number,
  draws: number
}> {
  const db = getDatabase();
  
  // Find the player's most recent match BEFORE the target sequence
  const lastMatchBefore = await db.get(`
    SELECT m.mu, m.sigma
    FROM matches m
    JOIN games_master gm ON m.gameId = gm.gameId
    WHERE m.userId = ? AND gm.gameSequence < ? AND gm.status = 'confirmed' AND gm.active = 1
    ORDER BY gm.gameSequence DESC, gm.createdAt DESC
    LIMIT 1
  `, [playerId, beforeSequence]);

  // Calculate cumulative W/L/D record up to (but not including) the target sequence
  const recordBefore = await db.get(`
    SELECT 
      SUM(CASE WHEN m.status = 'w' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN m.status = 'l' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN m.status = 'd' THEN 1 ELSE 0 END) as draws
    FROM matches m
    JOIN games_master gm ON m.gameId = gm.gameId
    WHERE m.userId = ? AND gm.gameSequence < ? AND gm.status = 'confirmed' AND gm.active = 1
  `, [playerId, beforeSequence]);

  return {
    mu: lastMatchBefore?.mu || 25.0,
    sigma: lastMatchBefore?.sigma || 8.333,
    wins: recordBefore?.wins || 0,
    losses: recordBefore?.losses || 0,
    draws: recordBefore?.draws || 0
  };
}

async function getDeckStateBeforeSequence(deckName: string, beforeSequence: number): Promise<{
  displayName: string,
  mu: number,
  sigma: number,
  wins: number,
  losses: number,
  draws: number
}> {
  const db = getDatabase();
  
  // Find the deck's most recent match BEFORE the target sequence
  const lastMatchBefore = await db.get(`
    SELECT dm.mu, dm.sigma, dm.deckDisplayName
    FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE dm.deckNormalizedName = ? AND gm.gameSequence < ? AND gm.status = 'confirmed' AND gm.active = 1
    ORDER BY gm.gameSequence DESC, gm.createdAt DESC
    LIMIT 1
  `, [deckName, beforeSequence]);

  // Calculate cumulative W/L/D record up to (but not including) the target sequence
  const recordBefore = await db.get(`
    SELECT 
      SUM(CASE WHEN dm.status = 'w' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN dm.status = 'l' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN dm.status = 'd' THEN 1 ELSE 0 END) as draws
    FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE dm.deckNormalizedName = ? AND gm.gameSequence < ? AND gm.status = 'confirmed' AND gm.active = 1
  `, [deckName, beforeSequence]);

  // Get display name from current deck record or fallback
  const currentDeck = await db.get('SELECT displayName FROM decks WHERE normalizedName = ?', deckName);

  return {
    displayName: lastMatchBefore?.deckDisplayName || currentDeck?.displayName || deckName,
    mu: lastMatchBefore?.mu || 25.0,
    sigma: lastMatchBefore?.sigma || 8.333,
    wins: recordBefore?.wins || 0,
    losses: recordBefore?.losses || 0,
    draws: recordBefore?.draws || 0
  };
}

async function replayPlayerGame(gameId: string): Promise<void> {
  const db = getDatabase();
  const matches = await db.all('SELECT * FROM matches WHERE gameId = ? ORDER BY matchDate ASC', gameId);
  
  if (matches.length === 0) return;

  // Get current ratings for all players
  const playerRatings: Record<string, any> = {};
  const playerStats: Record<string, any> = {};
  
  for (const match of matches) {
    const player = await getOrCreatePlayer(match.userId);
    const { rating } = await import('openskill');
    playerRatings[match.userId] = rating({ mu: player.mu, sigma: player.sigma });
    playerStats[match.userId] = {
      wins: player.wins,
      losses: player.losses,
      draws: player.draws
    };
  }

  // Apply OpenSkill rating calculation
  const { rate } = await import('openskill');
  const gameRatings = matches.map(match => [playerRatings[match.userId]]);
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = matches.map(match => statusRank[match.status] || 3);
  const newRatings = rate(gameRatings, { rank: ranks });

  // Apply penalties and minimum changes
  const penalty = matches.length === 3 ? 0.9 : 1.0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const newRating = newRatings[i][0];
    
    const finalRating = {
      mu: 25 + (newRating.mu - 25) * penalty,
      sigma: newRating.sigma
    };

    const oldRating = playerRatings[match.userId];
    const adjustedRating = ensureMinimumRatingChange(oldRating, finalRating, match.status);

    // Update stats
    const stats = playerStats[match.userId];
    if (match.status === 'w') stats.wins++;
    else if (match.status === 'l') stats.losses++;
    else if (match.status === 'd') stats.draws++;

    // Save to database
    await updatePlayerRating(
      match.userId,
      adjustedRating.mu,
      adjustedRating.sigma,
      stats.wins,
      stats.losses,
      stats.draws
    );
  }
}

async function replayDeckGame(gameId: string): Promise<void> {
  const db = getDatabase();
  const matches = await db.all('SELECT * FROM deck_matches WHERE gameId = ? ORDER BY matchDate ASC', gameId);
  
  if (matches.length === 0) return;

  // Get current ratings for all unique decks
  const uniqueDecks = new Set(matches.map(m => m.deckNormalizedName));
  const deckRatings: Record<string, any> = {};
  const deckStats: Record<string, any> = {};
  
  for (const deckName of uniqueDecks) {
    const match = matches.find(m => m.deckNormalizedName === deckName);
    const deck = await getOrCreateDeck(deckName, match.deckDisplayName);
    const { rating } = await import('openskill');
    deckRatings[deckName] = rating({ mu: deck.mu, sigma: deck.sigma });
    deckStats[deckName] = {
      wins: deck.wins,
      losses: deck.losses,
      draws: deck.draws,
      displayName: deck.displayName
    };
  }

  // Apply OpenSkill and handle duplicates
  const { rate } = await import('openskill');
  const gameRatings = matches.map(match => [deckRatings[match.deckNormalizedName]]);
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = matches.map(match => statusRank[match.status] || 3);
  const newRatings = rate(gameRatings, { rank: ranks });
  const penalty = matches.length === 3 ? 0.9 : 1.0;

  // Aggregate changes for duplicate decks
  const deckChanges: Record<string, { newRating: any, statusUpdates: string[] }> = {};

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const newRating = newRatings[i][0];
    
    const finalRating = {
      mu: 25 + (newRating.mu - 25) * penalty,
      sigma: newRating.sigma
    };

    if (!deckChanges[match.deckNormalizedName]) {
      deckChanges[match.deckNormalizedName] = {
        newRating: finalRating,
        statusUpdates: []
      };
    }

    deckChanges[match.deckNormalizedName].statusUpdates.push(match.status);
    deckChanges[match.deckNormalizedName].newRating = finalRating;
  }

  // Apply changes to unique decks
  for (const [deckName, changes] of Object.entries(deckChanges)) {
    const stats = deckStats[deckName];
    
    for (const status of changes.statusUpdates) {
      if (status === 'w') stats.wins++;
      else if (status === 'l') stats.losses++;
      else if (status === 'd') stats.draws++;
    }

    await updateDeckRating(
      deckName,
      stats.displayName,
      changes.newRating.mu,
      changes.newRating.sigma,
      stats.wins,
      stats.losses,
      stats.draws
    );
  }
}

function ensureMinimumRatingChange(oldRating: any, newRating: any, status: string): any {
  const oldElo = calculateElo(oldRating.mu, oldRating.sigma);
  const newElo = calculateElo(newRating.mu, newRating.sigma);
  const actualChange = newElo - oldElo;
  
  if (status === 'w' && actualChange < 2) {
    const targetElo = oldElo + 2;
    const targetMu = 25 + (targetElo - 1000 + (newRating.sigma - 8.333) * 4) / 12;
    return { mu: targetMu, sigma: newRating.sigma };
  } else if (status === 'l' && actualChange > -2) {
    const targetElo = oldElo - 2;
    const targetMu = 25 + (targetElo - 1000 + (newRating.sigma - 8.333) * 4) / 12;
    return { mu: targetMu, sigma: newRating.sigma };
  }
  
  return newRating;
}

async function handleCommanderRatingModification(
  interaction: ChatInputCommandInteraction,
  commanderName: string,
  mu: number | null,
  sigma: number | null,
  elo: number | null,
  wldString: string | null,
  adminId: string
) {
  // Validate commander
  try {
    if (!await validateCommander(commanderName)) {
      await interaction.reply({
        content: `"${commanderName}" is not a valid commander name according to EDHREC.`,
        ephemeral: true
      });
      return;
    }
  } catch (error) {
    await interaction.reply({
      content: `Unable to validate commander "${commanderName}".`,
      ephemeral: true
    });
    return;
  }

  // Parse W/L/D if provided
  let wldRecord = null;
  if (wldString) {
    const wldMatch = wldString.match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!wldMatch) {
      await interaction.reply({
        content: 'W/L/D format must be "wins/losses/draws" (e.g., "10/5/2").',
        ephemeral: true
      });
      return;
    }
    wldRecord = {
      wins: parseInt(wldMatch[1]),
      losses: parseInt(wldMatch[2]),
      draws: parseInt(wldMatch[3])
    };
  }

  const result = await handleDeckRatingChanges(commanderName, mu, sigma, elo, wldRecord, adminId);

  const embed = new EmbedBuilder()
    .setTitle('Commander Rating Updated')
    .setDescription(result)
    .setColor(0x00AE86)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// Helper functions
async function gameExists(gameId: string): Promise<boolean> {
  const db = getDatabase();
  const game = await db.get('SELECT gameId FROM games_master WHERE gameId = ?', gameId);
  return !!game;
}

async function handleRatingChanges(
  targetUserId: string,
  targetUser: User | null,
  mu: number | null,
  sigma: number | null,
  elo: number | null,
  wldRecord: { wins: number; losses: number; draws: number } | null,
  adminId: string
): Promise<string> {
  const player = await getOrCreatePlayer(targetUserId);
  const displayName = targetUser?.displayName || targetUserId;
  
  const oldMu = player.mu;
  const oldSigma = player.sigma;
  const oldElo = calculateElo(oldMu, oldSigma);
  const oldWins = player.wins;
  const oldLosses = player.losses;
  const oldDraws = player.draws;

  let newMu = mu !== null ? mu : oldMu;
  let newSigma = sigma !== null ? sigma : oldSigma;
  let newElo = elo !== null ? elo : calculateElo(newMu, newSigma);
  
  if (elo !== null) {
    newMu = 25 + (elo - 1000) / 12;
    newSigma = 8.333;
  }

  let newWins = wldRecord ? wldRecord.wins : oldWins;
  let newLosses = wldRecord ? wldRecord.losses : oldLosses;
  let newDraws = wldRecord ? wldRecord.draws : oldDraws;

  const snapshot: SetCommandSnapshot = {
    matchId: `set-${Date.now()}`,
    gameId: 'manual',
    gameSequence: Date.now(),
    gameType: 'set_command',
    operationType: 'rating_change',
    targetType: 'player',
    targetId: targetUserId,
    before: {
      mu: oldMu,
      sigma: oldSigma,
      wins: oldWins,
      losses: oldLosses,
      draws: oldDraws
    },
    after: {
      mu: newMu,
      sigma: newSigma,
      wins: newWins,
      losses: newLosses,
      draws: newDraws
    },
    metadata: {
      adminUserId: adminId,
      parameters: JSON.stringify({ mu, sigma, elo, wld: wldRecord }),
      reason: 'Manual player rating adjustment via /set command'
    },
    timestamp: new Date().toISOString(),
    description: `Set player rating for ${displayName}`
  };

  saveOperationSnapshot(snapshot);

  await updatePlayerRating(targetUserId, newMu, newSigma, newWins, newLosses, newDraws);

  await logRatingChange({
    targetType: 'player',
    targetId: targetUserId,
    targetDisplayName: displayName,
    changeType: 'manual',
    adminUserId: adminId,
    oldMu,
    oldSigma,
    oldElo,
    newMu,
    newSigma,
    newElo: calculateElo(newMu, newSigma),
    oldWins,
    oldLosses,
    oldDraws,
    newWins,
    newLosses,
    newDraws,
    parameters: JSON.stringify({ mu, sigma, elo, wld: wldRecord }),
    reason: 'Manual rating adjustment via /set command'
  });

  let changes = [];
  if (mu !== null || elo !== null) changes.push(`Elo: ${oldElo} → ${calculateElo(newMu, newSigma)}`);
  if (wldRecord) changes.push(`W/L/D: ${oldWins}/${oldLosses}/${oldDraws} → ${newWins}/${newLosses}/${newDraws}`);

  return `Rating Updated for ${displayName}\n${changes.join('\n')}`;
}

async function handleDeckRatingChanges(
  deckName: string,
  mu: number | null,
  sigma: number | null,
  elo: number | null,
  wldRecord: { wins: number; losses: number; draws: number } | null,
  adminId: string
): Promise<string> {
  const normalizedName = normalizeCommanderName(deckName);
  const deck = await getOrCreateDeck(normalizedName, deckName);
  
  const oldMu = deck.mu;
  const oldSigma = deck.sigma;
  const oldElo = calculateElo(oldMu, oldSigma);
  const oldWins = deck.wins;
  const oldLosses = deck.losses;
  const oldDraws = deck.draws;

  let newMu = mu !== null ? mu : oldMu;
  let newSigma = sigma !== null ? sigma : oldSigma;
  let newElo = elo !== null ? elo : calculateElo(newMu, newSigma);
  
  if (elo !== null) {
    newMu = 25 + (elo - 1000) / 12;
    newSigma = 8.333;
  }

  let newWins = wldRecord ? wldRecord.wins : oldWins;
  let newLosses = wldRecord ? wldRecord.losses : oldLosses;
  let newDraws = wldRecord ? wldRecord.draws : oldDraws;

  const snapshot: SetCommandSnapshot = {
    matchId: `set-${Date.now()}`,
    gameId: 'manual',
    gameSequence: Date.now(),
    gameType: 'set_command',
    operationType: 'rating_change',
    targetType: 'deck',
    targetId: normalizedName,
    before: {
      mu: oldMu,
      sigma: oldSigma,
      wins: oldWins,
      losses: oldLosses,
      draws: oldDraws
    },
    after: {
      mu: newMu,
      sigma: newSigma,
      wins: newWins,
      losses: newLosses,
      draws: newDraws
    },
    metadata: {
      adminUserId: adminId,
      parameters: JSON.stringify({ mu, sigma, elo, wld: wldRecord }),
      reason: 'Manual deck rating adjustment via /set command'
    },
    timestamp: new Date().toISOString(),
    description: `Set deck rating for ${deck.displayName}`
  };

  saveOperationSnapshot(snapshot);

  await updateDeckRating(normalizedName, deck.displayName, newMu, newSigma, newWins, newLosses, newDraws);

  await logRatingChange({
    targetType: 'deck',
    targetId: normalizedName,
    targetDisplayName: deck.displayName,
    changeType: 'manual',
    adminUserId: adminId,
    oldMu,
    oldSigma,
    oldElo,
    newMu,
    newSigma,
    newElo: calculateElo(newMu, newSigma),
    oldWins,
    oldLosses,
    oldDraws,
    newWins,
    newLosses,
    newDraws,
    parameters: JSON.stringify({ mu, sigma, elo, wld: wldRecord }),
    reason: 'Manual rating adjustment via /set command'
  });

  let changes = [];
  if (mu !== null || elo !== null) changes.push(`Elo: ${oldElo} → ${calculateElo(newMu, newSigma)}`);
  if (wldRecord) changes.push(`W/L/D: ${oldWins}/${oldLosses}/${oldDraws} → ${newWins}/${newLosses}/${newDraws}`);

  return `Commander Rating Updated for ${deck.displayName}\n${changes.join('\n')}`;
}

async function handleDeckAssignment(
  targetUserId: string,
  targetUser: User | null,
  deckName: string,
  gameId: string | null,
  requesterId: string
): Promise<string> {
  const db = getDatabase();
  const displayName = targetUser?.displayName || targetUserId;

  // Get current state for snapshot
  const player = await db.get('SELECT defaultDeck FROM players WHERE userId = ?', targetUserId);
  const beforeDefaultDeck = player?.defaultDeck || null;

  if (deckName === 'nocommander' || (!gameId || gameId === 'allgames')) {
    const normalizedName = deckName !== 'nocommander' ? normalizeCommanderName(deckName) : null;
    
    // Create snapshot for default deck changes
    const snapshot: SetCommandSnapshot = {
      matchId: `set-${Date.now()}`,
      gameId: gameId || 'manual',
      gameSequence: Date.now(),
      gameType: 'set_command',
      operationType: 'deck_assignment',
      targetType: 'player',
      targetId: targetUserId,
      before: { defaultDeck: beforeDefaultDeck },
      after: { defaultDeck: normalizedName },
      metadata: {
        adminUserId: requesterId,
        parameters: JSON.stringify({ deckName, gameId }),
        reason: `Deck assignment change via /set command`
      },
      timestamp: new Date().toISOString(),
      description: `Set deck assignment for ${displayName}`
    };

    // Save snapshot BEFORE making changes
    saveOperationSnapshot(snapshot);
  }
  
  // For game-specific assignments, also create snapshots
  if (gameId && gameId !== 'allgames' && gameId !== 'manual') {
    // Get current game-specific assignment
    const currentAssignment = await db.get(`
      SELECT deckNormalizedName FROM player_deck_assignments 
      WHERE userId = ? AND gameId = ?
    `, targetUserId, gameId);
    
    const normalizedName = deckName !== 'nocommander' ? normalizeCommanderName(deckName) : null;
    
    const snapshot: SetCommandSnapshot = {
      matchId: `set-${Date.now()}`,
      gameId: gameId,
      gameSequence: Date.now(),
      gameType: 'set_command',
      operationType: 'deck_assignment',
      targetType: 'player',
      targetId: targetUserId,
      before: { gameSpecificDeck: currentAssignment?.deckNormalizedName || null },
      after: { gameSpecificDeck: normalizedName },
      metadata: {
        adminUserId: requesterId,
        parameters: JSON.stringify({ deckName, gameId }),
        reason: `Game-specific deck assignment via /set command`
      },
      timestamp: new Date().toISOString(),
      description: `Set deck assignment for ${displayName} in game ${gameId}`
    };

    saveOperationSnapshot(snapshot);
  }
  
  if (deckName === 'nocommander') {
    if (gameId === 'allgames') {
      await db.run('DELETE FROM player_deck_assignments WHERE userId = ?', targetUserId);
      await db.run('UPDATE players SET defaultDeck = NULL WHERE userId = ?', targetUserId);
      return `Removed all deck assignments for ${displayName}`;
    } else if (gameId) {
      await db.run('DELETE FROM player_deck_assignments WHERE userId = ? AND gameId = ?', targetUserId, gameId);
      return `Removed deck assignment for ${displayName} in game ${gameId}`;
    } else {
      await db.run('UPDATE players SET defaultDeck = NULL WHERE userId = ?', targetUserId);
      return `Removed default deck for ${displayName}`;
    }
  } else {
    const normalizedName = normalizeCommanderName(deckName);
    
    await getOrCreateDeck(normalizedName, deckName);
    
    if (gameId === 'allgames') {
      await db.run('UPDATE players SET defaultDeck = ? WHERE userId = ?', normalizedName, targetUserId);
      await db.run('UPDATE matches SET assignedDeck = ? WHERE userId = ?', normalizedName, targetUserId);
      await db.run(`
        UPDATE deck_matches 
        SET assignedPlayer = ? 
        WHERE deckNormalizedName = ? AND assignedPlayer IS NULL
      `, targetUserId, normalizedName);
      
      return `Set ${deckName} as default deck for ${displayName} (all games)`;
    } else if (gameId) {
      await db.run(`
        INSERT OR REPLACE INTO player_deck_assignments 
        (userId, gameId, deckNormalizedName, deckDisplayName, assignmentType, createdBy)
        VALUES (?, ?, ?, ?, 'game_specific', ?)
      `, [targetUserId, gameId, normalizedName, deckName, requesterId]);
      
      await db.run('UPDATE matches SET assignedDeck = ? WHERE userId = ? AND gameId = ?', normalizedName, targetUserId, gameId);
      
      return `Assigned ${deckName} to ${displayName} for game ${gameId}`;
    } else {
      await db.run('UPDATE players SET defaultDeck = ? WHERE userId = ?', normalizedName, targetUserId);
      return `Set ${deckName} as default deck for ${displayName}`;
    }
  }
}