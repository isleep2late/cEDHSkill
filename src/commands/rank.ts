import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  TextChannel,
  User
} from 'discord.js';
import { rate, Rating, rating } from 'openskill';
import type { ExtendedClient } from '../bot.js';
import { recordPlayerActivity } from '../bot.js';
import { getOrCreatePlayer, updatePlayerRating, isPlayerRestricted, getAllPlayers } from '../db/player-utils.js';
import { recordMatch, getRecentMatches, updateMatchTurnOrder } from '../db/match-utils.js';
import { 
  getOrCreateDeck, 
  updateDeckRating, 
  recordDeckMatch,
  getAllDecks
} from '../db/deck-utils.js';
import { saveMatchSnapshot } from '../utils/snapshot-utils.js';
import { calculateElo, muFromElo } from '../utils/elo-utils.js';

// Participation bonus: +1 Elo for playing a ranked game
const PARTICIPATION_BONUS_ELO = 1;
import { generateUniqueGameId, recordGameId } from '../utils/game-id-utils.js';
import { config } from '../config.js';
import crypto from 'crypto';
import { isExempt, getAlertOptIn } from '../utils/suspicion-utils.js';
import { logRatingChange } from '../utils/rating-audit-utils.js';
import { normalizeCommanderName, validateCommander } from '../utils/edhrec-utils.js';
import { cleanupZeroPlayers, cleanupZeroDecks } from '../db/database-utils.js';

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

// Rate limiting for Discord API calls
class DiscordRateLimiter {
  private userFetchQueue: Map<string, Promise<User | null>> = new Map();
  private lastFetchTime = 0;
  private readonly minInterval = 100; // 100ms between API calls

  async fetchUserSafe(client: ExtendedClient, userId: string): Promise<User | null> {
    // Return existing promise if already fetching this user
    if (this.userFetchQueue.has(userId)) {
      return this.userFetchQueue.get(userId)!;
    }

    const fetchPromise = this.performFetch(client, userId);
    this.userFetchQueue.set(userId, fetchPromise);
    
    // Clean up after completion
    fetchPromise.finally(() => {
      this.userFetchQueue.delete(userId);
    });

    return fetchPromise;
  }

  private async performFetch(client: ExtendedClient, userId: string): Promise<User | null> {
    try {
      // Rate limiting - ensure minimum interval between calls
      const now = Date.now();
      const timeSinceLastFetch = now - this.lastFetchTime;
      if (timeSinceLastFetch < this.minInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastFetch));
      }
      this.lastFetchTime = Date.now();

      const user = await client.users.fetch(userId);
      return user;
    } catch (error) {
      console.error(`Failed to fetch user ${userId}:`, error);
      return null;
    }
  }
}

const rateLimiter = new DiscordRateLimiter();

// Input validation utilities
class InputValidator {
  static validateUserId(userId: string): boolean {
    // Discord user IDs are 17-19 digit numbers
    return /^\d{17,19}$/.test(userId);
  }

  static validateGameId(gameId: string): boolean {
  // Game IDs should be 6-8 alphanumeric characters, but "0" is special case for pre-injection
  if (gameId === '0') return true;
  return /^[A-Z0-9]{6,8}$/.test(gameId);
}

  static validateTurnOrder(turnOrder: number, maxPlayers: number = 4): boolean {
    return Number.isInteger(turnOrder) && turnOrder >= 1 && turnOrder <= maxPlayers;
  }

  static validateCommanderName(commanderName: string): boolean {
    // Basic validation - alphanumeric, hyphens, and spaces only
    return /^[a-zA-Z0-9\s\-',.]+$/.test(commanderName) && commanderName.length >= 2 && commanderName.length <= 100;
  }

  static validateGameResult(result: string): result is 'w' | 'l' | 'd' {
    return ['w', 'l', 'd'].includes(result.toLowerCase());
  }

  static validatePlayerCount(count: number, isCEDHMode: boolean = true): boolean {
    if (isCEDHMode) {
      return count === 4; // cEDH mode requires exactly 4 players
    }
    return count >= 2 && count <= 4;
  }

  static validateDeckCount(count: number): boolean {
    return count >= 3 && count <= 4;
  }

  static validateResultCombination(results: string[]): { valid: boolean; error?: string } {
    const winCount = results.filter(r => r === 'w').length;
    const drawCount = results.filter(r => r === 'd').length;
    const lossCount = results.filter(r => r === 'l').length;

    // Must have at least one result
    if (results.length === 0) {
      return { valid: false, error: 'No results provided' };
    }

    // All results must be w, l, or d
    if (winCount + drawCount + lossCount !== results.length) {
      return { valid: false, error: 'Invalid result format. Use only w (win), l (loss), or d (draw)' };
    }

    // cEDH validation: ONLY allow these two scenarios:
      // 1. Exactly 1 winner and 3 losers (no draws)
      // 2. All 4 draws (no winners, no losers)
  
      // Scenario 1: 1 winner, 3 losers, 0 draws
      if (winCount === 1 && lossCount === 3 && drawCount === 0) {
        return { valid: true };
      }
  
      // Scenario 2: 0 winners, 0 losers, 4 draws
      if (winCount === 0 && lossCount === 0 && drawCount === 4) {
        return { valid: true };
      }

      // Any other combination is invalid
      return { valid: false, error: 'Invalid result combination. Must be either: 1 winner + 3 losers, or 4 draws' };
    }


  static validateTurnOrders(turnOrders: number[]): { valid: boolean; error?: string } {
    const provided = turnOrders.filter(t => t > 0);
    const unique = new Set(provided);

    if (provided.length !== unique.size) {
      return { valid: false, error: 'Duplicate turn orders detected' };
    }

    for (const turnOrder of provided) {
      if (!this.validateTurnOrder(turnOrder)) {
        return { valid: false, error: `Invalid turn order: ${turnOrder}. Must be between 1 and 4` };
      }
    }

    return { valid: true };
  }
}

// Enhanced error handling wrapper
class DatabaseErrorHandler {
  static async safeExecute<T>(
    operation: () => Promise<T>, 
    operationName: string,
    fallbackValue?: T
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    try {
      const result = await operation();
      return { success: true, data: result };
    } catch (error) {
      console.error(`Database operation failed [${operationName}]:`, error);
      
      if (fallbackValue !== undefined) {
        return { success: false, data: fallbackValue, error: `${operationName} failed, using fallback` };
      }
      
      return { 
        success: false, 
        error: error instanceof Error ? error.message : `Unknown error in ${operationName}` 
      };
    }
  }

  static async safeTransaction<T>(
    operations: (() => Promise<void>)[],
    operationName: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      for (const operation of operations) {
        await operation();
      }
      return { success: true };
    } catch (error) {
      console.error(`Transaction failed [${operationName}]:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : `Transaction failed in ${operationName}` 
      };
    }
  }
}

// Enhanced commander validation with retries and caching
class CommanderValidator {
  private static cache = new Map<string, boolean>();
  private static cacheExpiry = new Map<string, number>();
  private static readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  private static pendingValidations = new Map<string, Promise<boolean>>();

  static async validateCommander(commanderName: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Input validation
      if (!InputValidator.validateCommanderName(commanderName)) {
        return { valid: false, error: 'Invalid commander name format' };
      }

      const normalizedName = normalizeCommanderName(commanderName);
      
      // Check cache first
      const cached = this.getCached(normalizedName);
      if (cached !== null) {
        return { valid: cached };
      }

      // Check if validation is already in progress
      if (this.pendingValidations.has(normalizedName)) {
        const result = await this.pendingValidations.get(normalizedName)!;
        return { valid: result };
      }

      // Start new validation
      const validationPromise = this.performValidation(normalizedName);
      this.pendingValidations.set(normalizedName, validationPromise);

      try {
        const isValid = await validationPromise;
        this.setCached(normalizedName, isValid);
        return { valid: isValid };
      } finally {
        this.pendingValidations.delete(normalizedName);
      }
    } catch (error) {
      console.error(`Commander validation error for ${commanderName}:`, error);
      return { valid: false, error: 'Validation service temporarily unavailable' };
    }
  }

  private static getCached(normalizedName: string): boolean | null {
    const expiry = this.cacheExpiry.get(normalizedName);
    if (expiry && Date.now() < expiry) {
      return this.cache.get(normalizedName) || null;
    }
    return null;
  }

  private static setCached(normalizedName: string, isValid: boolean): void {
    this.cache.set(normalizedName, isValid);
    this.cacheExpiry.set(normalizedName, Date.now() + this.CACHE_DURATION);
  }

  private static async performValidation(normalizedName: string): Promise<boolean> {
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

        const response = await fetch(`https://edhrec.com/commanders/${normalizedName}`, {
          method: 'HEAD',
          signal: controller.signal,
          headers: {
            'User-Agent': 'cEDHSkill-Bot/1.0'
          }
        });

        clearTimeout(timeoutId);
        return response.status === 200;
      } catch (error) {
        console.warn(`Commander validation attempt ${attempt} failed for ${normalizedName}:`, error);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
      }
    }

    console.error(`All validation attempts failed for ${normalizedName}`);
    return false;
  }
}

// Enhanced user fetching with error handling
async function fetchUsernames(
  client: ExtendedClient, 
  userIds: string[]
): Promise<{ userNames: Record<string, string>; failures: string[] }> {
  const userNames: Record<string, string> = {};
  const failures: string[] = [];

  // Validate user IDs first
  const validUserIds = userIds.filter(id => InputValidator.validateUserId(id));
  const invalidIds = userIds.filter(id => !InputValidator.validateUserId(id));
  
  for (const invalidId of invalidIds) {
    console.warn(`Invalid user ID format: ${invalidId}`);
    userNames[invalidId] = `<@${invalidId}>`;
    failures.push(invalidId);
  }

  // Batch fetch with rate limiting
  const fetchPromises = validUserIds.map(async (userId) => {
    const user = await rateLimiter.fetchUserSafe(client, userId);
    if (user) {
      userNames[userId] = `@${user.username}`;
    } else {
      userNames[userId] = `<@${userId}>`;
      failures.push(userId);
    }
  });

  await Promise.all(fetchPromises);
  return { userNames, failures };
}

async function getNextGameSequence(afterGameId?: string): Promise<number> {
  try {
    const { getDatabase } = await import('../db/init.js');
    const db = getDatabase();

    if (!afterGameId) {
      const result = await db.get('SELECT MAX(gameSequence) as maxSeq FROM games_master WHERE status = "confirmed" AND active = 1');
      return (result?.maxSeq || 0) + 1.0;
    }

    // ENHANCED: Handle special case "0" for pre-injection (before all games)
    if (afterGameId === '0') {
      // Find the minimum sequence number and place the new game before it
      const result = await db.get('SELECT MIN(gameSequence) as minSeq FROM games_master WHERE status = "confirmed" AND active = 1');
      const minSequence = result?.minSeq || 1.0;
      
      // Place the new game at half the minimum sequence (ensuring it comes first)
      return minSequence / 2;
    }

    if (!InputValidator.validateGameId(afterGameId)) {
      throw new Error(`Invalid game ID format: ${afterGameId}`);
    }

    const targetGame = await db.get('SELECT gameSequence FROM games_master WHERE gameId = ? AND status = "confirmed" AND active = 1', afterGameId);
    if (!targetGame) {
      throw new Error(`Game ID "${afterGameId}" not found or is not confirmed`);
    }

    const nextGame = await db.get(
      'SELECT MIN(gameSequence) as nextSeq FROM games_master WHERE gameSequence > ? AND status = "confirmed"',
      targetGame.gameSequence
    );

    return nextGame?.nextSeq 
      ? (targetGame.gameSequence + nextGame.nextSeq) / 2
      : targetGame.gameSequence + 1.0;
  } catch (error) {
    console.error('Error in getNextGameSequence:', error);
    throw error;
  }
}

// Function to store game in games_master table with sequence
async function storeGameInMaster(gameId: string, gameSequence: number, submittedBy: string, gameType: 'player' | 'deck', submittedByAdmin: boolean): Promise<void> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  await db.run(`
  INSERT INTO games_master (gameId, gameSequence, gameType, submittedBy, submittedByAdmin, status, active)
  VALUES (?, ?, ?, ?, ?, 'confirmed', 1)
`, [gameId, gameSequence, gameType, submittedBy, submittedByAdmin ? 1 : 0]);
}

// Function to update all match records with game sequence
async function updateMatchesWithSequence(gameId: string, gameSequence: number, gameType: 'player' | 'deck'): Promise<void> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();
  
  if (gameType === 'player') {
    await db.run('UPDATE matches SET gameSequence = ? WHERE gameId = ?', [gameSequence, gameId]);
  } else {
    await db.run('UPDATE deck_matches SET gameSequence = ? WHERE gameId = ?', [gameSequence, gameId]);
  }
  await db.run('UPDATE game_ids SET gameSequence = ?, status = "confirmed" WHERE gameId = ?', [gameSequence, gameId]);
}

// Function to recalculate ALL player ratings from scratch in chronological order
async function recalculateAllPlayersFromScratch(): Promise<void> {
  console.log('[RECALC] Starting complete player rating recalculation...');
  
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  // Get all players and reset their ratings to defaults
  const allPlayers = await getAllPlayers();
  for (const player of allPlayers) {
    await updatePlayerRating(player.userId, 25.0, 8.333, 0, 0, 0);
  }

  // Get all games in chronological order (by sequence)
  const allGames = await db.all(`
  SELECT gameId, gameSequence 
  FROM games_master 
  WHERE gameType = 'player' AND status = 'confirmed' AND active = 1
  ORDER BY gameSequence ASC
`);

  // Replay each game in order
  for (const game of allGames) {
    await replayPlayerGame(game.gameId);
  }

  console.log(`[RECALC] Completed recalculation of ${allGames.length} player games`);
}

// Function to recalculate ALL deck ratings from scratch in chronological order
async function recalculateAllDecksFromScratch(): Promise<void> {
  console.log('[RECALC] Starting complete deck rating recalculation...');
  
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  // Get all decks and reset their ratings to defaults
  const allDecks = await getAllDecks();
  for (const deck of allDecks) {
    await updateDeckRating(deck.normalizedName, deck.displayName, 25.0, 8.333, 0, 0, 0);
  }

  // Get all games in chronological order (by sequence)
  const allGames = await db.all(`
    SELECT gameId, gameSequence 
    FROM games_master 
    WHERE gameType = 'deck' AND status = 'confirmed'
    ORDER BY gameSequence ASC
  `);

  // Replay each game in order
  for (const game of allGames) {
    await replayDeckGame(game.gameId);
  }

  console.log(`[RECALC] Completed recalculation of ${allGames.length} deck games`);
}

// Function to replay a single player game (exported for use by /set command)
export async function replayPlayerGame(gameId: string): Promise<void> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();
  
  // Get all matches for this game
  const matches = await db.all('SELECT * FROM matches WHERE gameId = ? ORDER BY matchDate ASC', gameId);
  
  if (matches.length === 0) return;

  // Get current ratings for all players in this game
  const playerRatings: Record<string, any> = {};
  const playerStats: Record<string, any> = {};
  
  for (const match of matches) {
    const player = await getOrCreatePlayer(match.userId);
    playerRatings[match.userId] = rating({ mu: player.mu, sigma: player.sigma });
    playerStats[match.userId] = {
      wins: player.wins,
      losses: player.losses,
      draws: player.draws
    };
  }

  // Create ratings array in the same order as matches
  const gameRatings = matches.map(match => [playerRatings[match.userId]]);
  
  // Create ranks array based on match status
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = matches.map(match => statusRank[match.status] || 3);

  // Apply OpenSkill rating update
  const newRatings = rate(gameRatings, { rank: ranks });

  // Apply 3-player penalty if applicable
  const penalty = matches.length === 3 ? 0.9 : 1.0;

  // Update each player
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const newRating = newRatings[i][0];
    
    // Apply penalty
    const finalRating = {
      mu: 25 + (newRating.mu - 25) * penalty,
      sigma: newRating.sigma
    };

    // Apply minimum rating changes
    const oldRating = playerRatings[match.userId];
    let adjustedRating = ensureMinimumRatingChange(oldRating, finalRating, match.status);

    // Apply participation bonus (+1 Elo for playing ranked)
    adjustedRating = applyParticipationBonus(adjustedRating);

    // Update win/loss/draw counts
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

    // Update match record with recalculated mu/sigma values
    await db.run(
      'UPDATE matches SET mu = ?, sigma = ? WHERE gameId = ? AND userId = ?',
      [adjustedRating.mu, adjustedRating.sigma, gameId, match.userId]
    );

    // Log the rating change for audit trail (replay/recalculation)
    try {
      await logRatingChange({
        targetType: 'player',
        targetId: match.userId,
        targetDisplayName: `Player ${match.userId}`,
        changeType: 'game',
        oldMu: oldRating.mu,
        oldSigma: oldRating.sigma,
        oldElo: calculateElo(oldRating.mu, oldRating.sigma),
        newMu: adjustedRating.mu,
        newSigma: adjustedRating.sigma,
        newElo: calculateElo(adjustedRating.mu, adjustedRating.sigma),
        parameters: JSON.stringify({
          gameId: gameId,
          result: match.status,
          turnOrder: match.turnOrder,
          recalculation: true,
          submittedByAdmin: match.submittedByAdmin || false
        })
      });
    } catch (auditError) {
      console.error('Error logging player recalculation to audit trail:', auditError);
    }
  }
}

// Function to replay a single deck game (exported for use by /set command)
export async function replayDeckGame(gameId: string): Promise<void> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();
  
  // Get all deck matches for this game
  const matches = await db.all('SELECT * FROM deck_matches WHERE gameId = ? ORDER BY matchDate ASC', gameId);
  
  if (matches.length === 0) return;

  // Get current ratings for all UNIQUE decks in this game
  const uniqueDecks = new Set(matches.map(m => m.deckNormalizedName));
  const deckRatings: Record<string, any> = {};
  const deckStats: Record<string, any> = {};
  
  for (const deckName of uniqueDecks) {
    const match = matches.find(m => m.deckNormalizedName === deckName);
    const deck = await getOrCreateDeck(deckName, match.deckDisplayName);
    deckRatings[deckName] = rating({ mu: deck.mu, sigma: deck.sigma });
    deckStats[deckName] = {
      wins: deck.wins,
      losses: deck.losses,
      draws: deck.draws,
      displayName: deck.displayName
    };
  }

  // Create ratings array in the same order as matches (handling duplicates)
  const gameRatings = matches.map(match => [deckRatings[match.deckNormalizedName]]);
  
  // Create ranks array based on match status
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = matches.map(match => statusRank[match.status] || 3);

  // Apply OpenSkill rating update
  const newRatings = rate(gameRatings, { rank: ranks });

  // Apply 3-deck penalty if applicable
  const penalty = matches.length === 3 ? 0.9 : 1.0;

  // Process results and aggregate changes for duplicate decks
  const deckChanges: Record<string, { newRating: any, statusUpdates: string[] }> = {};

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const newRating = newRatings[i][0];
    
    // Apply penalty
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

    // Track status updates for this deck
    deckChanges[match.deckNormalizedName].statusUpdates.push(match.status);
    // Use the most recent rating update for duplicates
    deckChanges[match.deckNormalizedName].newRating = finalRating;
  }

  // Apply aggregated changes to each unique deck
  for (const [deckName, changes] of Object.entries(deckChanges)) {
    const stats = deckStats[deckName];

    // Apply participation bonus (+1 Elo for playing ranked)
    const bonusedRating = applyParticipationBonus(changes.newRating);

    // Count total wins/losses/draws for this deck in this game
    for (const status of changes.statusUpdates) {
      if (status === 'w') stats.wins++;
      else if (status === 'l') stats.losses++;
      else if (status === 'd') stats.draws++;
    }

    // Save to database
    await updateDeckRating(
      deckName,
      stats.displayName,
      bonusedRating.mu,
      bonusedRating.sigma,
      stats.wins,
      stats.losses,
      stats.draws
    );

    // Update all deck_match records for this deck with recalculated mu/sigma
    await db.run(
      'UPDATE deck_matches SET mu = ?, sigma = ? WHERE gameId = ? AND deckNormalizedName = ?',
      [bonusedRating.mu, bonusedRating.sigma, gameId, deckName]
    );

    // Log the deck rating change for audit trail (replay/recalculation)
    try {
      await logRatingChange({
        targetType: 'deck',
        targetId: deckName,
        targetDisplayName: stats.displayName,
        changeType: 'game',
        oldMu: deckRatings[deckName].mu,
        oldSigma: deckRatings[deckName].sigma,
        oldElo: calculateElo(deckRatings[deckName].mu, deckRatings[deckName].sigma),
        newMu: bonusedRating.mu,
        newSigma: bonusedRating.sigma,
        newElo: calculateElo(bonusedRating.mu, bonusedRating.sigma),
        parameters: JSON.stringify({
          gameId: gameId,
          duplicateCount: changes.statusUpdates.length,
          results: changes.statusUpdates,
          recalculation: true,
          is3DeckPenalty: matches.length === 3,
          participationBonus: PARTICIPATION_BONUS_ELO
        })
      });
    } catch (auditError) {
      console.error('Error logging deck recalculation to audit trail:', auditError);
    }
  }
}

// Helper function to rebuild turn order data from current reactions
async function buildTurnOrderFromReactions(message: any, players: PlayerEntry[]): Promise<Map<string, number>> {
  const turnOrderData = new Map<string, number>();
  const turnOrderEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  const validUserIds = new Set(players.map(p => p.userId));
  
  try {
    const freshMessage = await message.fetch();
    
    for (const [emojiName, reaction] of freshMessage.reactions.cache) {
      if (turnOrderEmojis.includes(emojiName)) {
        const turnOrder = turnOrderEmojis.indexOf(emojiName) + 1;
        const users = await reaction.users.fetch();
        
        for (const [userId, user] of users) {
          if (user.bot) continue;
          if (!validUserIds.has(userId)) continue;
          
          const playerHasTurnOrder = players.find(p => p.userId === userId)?.turnOrder !== undefined;
          if (playerHasTurnOrder) continue;
          
          const isAlreadyTaken = Array.from(turnOrderData.values()).includes(turnOrder);
          if (isAlreadyTaken) continue;
          
          turnOrderData.set(userId, turnOrder);
          break;
        }
      }
    }
  } catch (error) {
    console.error('Error rebuilding turn order from reactions:', error);
  }
  
  return turnOrderData;
}

// Show top 50 players and decks after major operations
async function showTop50PlayersAndDecks(interaction: ChatInputCommandInteraction): Promise<void> {
  // Players
  const allPlayers = await getAllPlayers();
  const { getRestrictedPlayers } = await import('../db/player-utils.js');
  const restricted = new Set(await getRestrictedPlayers());
  
  const filteredPlayers = allPlayers.filter((p: any) => {
    if (restricted.has(p.userId)) return false;
    const totalGames = (p.wins || 0) + (p.losses || 0) + (p.draws || 0);
    return totalGames > 0;
  });

  const rankedPlayers = filteredPlayers
    .map((p: any) => ({
      id: p.userId,
      elo: calculateElo(p.mu, p.sigma),
      totalGames: (p.wins || 0) + (p.losses || 0) + (p.draws || 0)
    }))
    .sort((a: any, b: any) => b.elo - a.elo)
    .slice(0, 50);

  // Decks
  const allDecks = await getAllDecks();
  
  const filteredDecks = allDecks.filter((d: any) => {
    const totalGames = (d.wins || 0) + (d.losses || 0) + (d.draws || 0);
    return totalGames > 0;
  });

  const rankedDecks = filteredDecks
    .map((d: any) => ({
      normalizedName: d.normalizedName,
      displayName: d.displayName,
      elo: calculateElo(d.mu, d.sigma),
      totalGames: (d.wins || 0) + (d.losses || 0) + (d.draws || 0)
    }))
    .sort((a: any, b: any) => b.elo - a.elo)
    .slice(0, 50);

  // Player description
  const playerDescription: string[] = [];
  let currentPlayerRank = 1;

  for (let i = 0; i < rankedPlayers.length; i++) {
    const player = rankedPlayers[i];
    
    if (i > 0 && player.elo !== rankedPlayers[i - 1].elo) {
      currentPlayerRank = i + 1;
    }

    let playerDisplay: string;
    try {
      const user = await interaction.client.users.fetch(player.id);
      playerDisplay = `@${user.username}`;
    } catch {
      playerDisplay = `<@${player.id}>`;
    }
    
    playerDescription.push(`RANK${currentPlayerRank}/POS${i + 1}. ${playerDisplay} - **${player.elo}** Elo`);
  }

  // Deck description
  const deckDescription = rankedDecks.map((deck: any, index: number) => {
    return `${index + 1}. **${deck.displayName}** - **${deck.elo}** Elo`;
  });

  const playerEmbed = new EmbedBuilder()
    .setTitle('🏆 Updated Top 50 Players')
    .setDescription(playerDescription.length > 0 ? playerDescription.join('\n') : 'No players found.')
    .setColor('Gold')
    .setFooter({ text: 'Player rankings updated after game injection/recalculation' });

  const deckEmbed = new EmbedBuilder()
    .setTitle('🃃 Updated Top 50 Decks')
    .setDescription(deckDescription.length > 0 ? deckDescription.join('\n') : 'No decks found.')
    .setColor('Purple')
    .setFooter({ text: 'Deck rankings updated after game injection/recalculation' });

  await interaction.followUp({ embeds: [playerEmbed, deckEmbed] });
}

// Helper function to update match turn orders after the fact
async function updateMatchTurnOrders(matchId: string, turnOrderSelections: Map<string, number>): Promise<void> {
  for (const [userId, turnOrder] of turnOrderSelections) {
    if (turnOrder > 0) {
      await updateMatchTurnOrder(matchId, userId, turnOrder);
    }
  }
}

// Ensure minimum rating changes (always +2 for winners, always -2 for losers)
function ensureMinimumRatingChange(oldRating: Rating, newRating: Rating, status: string): Rating {
  const oldElo = calculateElo(oldRating.mu, oldRating.sigma);
  const newElo = calculateElo(newRating.mu, newRating.sigma);
  const actualChange = newElo - oldElo;

  if (status === 'w') {
    // Winners must gain at least 2 points, always
    if (actualChange < 2) {
      const targetElo = oldElo + 2;
      // Convert back to mu (approximate)
      const targetMu = 25 + (targetElo - 1000 + (newRating.sigma - 8.333) * 4) / 12;
      return { mu: targetMu, sigma: newRating.sigma };
    }
  } else if (status === 'l') {
    // Losers must lose at least 2 points, always
    if (actualChange > -2) {
      const targetElo = oldElo - 2;
      // Convert back to mu (approximate)
      const targetMu = 25 + (targetElo - 1000 + (newRating.sigma - 8.333) * 4) / 12;
      return { mu: targetMu, sigma: newRating.sigma };
    }
  }
  // Draw players (status === 'd') can have any rating change

  return newRating;
}

/**
 * Apply participation bonus (+1 Elo) to a rating.
 * This is applied AFTER all other calculations as a reward for playing ranked.
 */
function applyParticipationBonus(rating: Rating): Rating {
  const currentElo = calculateElo(rating.mu, rating.sigma);
  const bonusElo = currentElo + PARTICIPATION_BONUS_ELO;
  const newMu = muFromElo(bonusElo, rating.sigma);
  return { mu: newMu, sigma: rating.sigma };
}

// Suspicious activity detection, admin games skipped entirely
async function checkForSuspiciousPatterns(
  userId: string,
  submittedByAdmin: boolean
): Promise<string | null> {
  if (submittedByAdmin) return null;
  if (await isExempt(userId)) return null;
  const recent = await getRecentMatches(userId, 50);
  const now = Date.now();

  // 1) Win streak in last 10 games (changed from 5 in 7 to 8 in 10)
const last10 = recent.slice(0, 10);
const winSet = new Set<string>();
for (const m of last10) {
  if (!m.submittedByAdmin && m.status === 'w') {
    winSet.add(m.id);
  }
}
if (winSet.size >= 8) {
  return `⚠️ Suspicious activity detected: <@${userId}> has won ${winSet.size} of their last 10 non-admin matches.`;
}

// 2) Submitting many wins in a short time (4 wins in 30 min) - FIXED
const submitterMap: Record<string, { timestamp: number; winnerId: string }[]> = {};
for (const m of recent) {
  if (!m.submittedByAdmin) { // Only count non-admin games
    const t = new Date(m.matchDate || m.timestamp).getTime();
    const submitterId = m.submitterId || m.userId;
    submitterMap[submitterId] = submitterMap[submitterId] || [];
    submitterMap[submitterId].push({ timestamp: t, winnerId: m.userId });
  }
}
for (const [submitter, entries] of Object.entries(submitterMap)) {
  const windowEntries = entries.filter(e => now - e.timestamp <= 30 * 60 * 1000);
  // Now windowEntries only contains non-admin games, so this check is correct
  const countByWinner: Record<string, number> = {};
  for (const e of windowEntries) {
    countByWinner[e.winnerId] = (countByWinner[e.winnerId] || 0) + 1;
  }
  for (const [winner, count] of Object.entries(countByWinner)) {
    if (count >= 4) {
      return `⚠️ Suspicious activity detected: <@${winner}> has won ${count} matches submitted in the last 30 minutes.`;
    }
  }
}

// 3) Repeated opponents: >=9 wins against same group - ALREADY CORRECT
const opponentKeyMap: Record<string, string[]> = {};
for (const m of recent) {
  if (m.status === 'w' && !m.submittedByAdmin) { // Correctly excludes admin games
    const teams = JSON.parse(m.teams || '[]');
    const scores = JSON.parse(m.scores || '[]');
    // Create a key based on match participants (simplified approach)
    const key = JSON.stringify([...teams, ...scores].sort());
    opponentKeyMap[m.userId] = opponentKeyMap[m.userId] || [];
    opponentKeyMap[m.userId].push(key);
  }
}
for (const [player, keys] of Object.entries(opponentKeyMap)) {
  const countMap: Record<string, number> = {};
  for (const key of keys) {
    countMap[key] = (countMap[key] || 0) + 1;
  }
  for (const count of Object.values(countMap)) {
    if (count >= 9) {
      return `⚠️ Suspicious activity detected: <@${player}> has won ${count} matches against the same group.`;
    }
  }
}

  return null;
}

type PlayerEntry = {
  userId: string;
  team?: string;
  score?: number;
  status?: string;
  place?: number;
  turnOrder?: number;
  commander?: string;
  normalizedCommanderName?: string;
};

type DeckEntry = {
  commander: string;
  normalizedName: string;
  status: 'w' | 'l' | 'd';
  turnOrder: number;
};

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Submit game results - supports players, commanders, or both!')
  .addStringOption(option =>
    option
      .setName('results')
      .setDescription('Results string - can include @users and/or commander names with w/l/d')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('aftergame')
      .setDescription('Admin only: Inject this game after specified game ID or 0 to place before all games')
      .setRequired(false)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  client: ExtendedClient
): Promise<void> {
  const input = interaction.options.getString('results', true);
  const afterGameId = interaction.options.getString('aftergame');

  // Defer immediately to prevent interaction timeout
  await interaction.deferReply();

  // Check if user is admin for aftergame parameter
  if (afterGameId && !config.admins.includes(interaction.user.id)) {
    await interaction.editReply({
      content: 'Only admins can inject games using the `aftergame` parameter.'
    });
    return;
  }

  // Check for deck-only mode (no user mentions at all)
  const hasUserMentions = /<@!?\d+>/.test(input);

  if (!hasUserMentions) {
    // No user mentions found - this is deck-only mode
    await executeDeckOnlyMode(interaction, client, input, afterGameId);
    return;
  }

  // If we get here, there are user mentions, so extract user IDs for validation
  const mentionMatches = input.match(/<@!?\d+>/g);
  const userIds = mentionMatches!.map(t => t.replace(/\D/g, ''));

  // Check for restricted players
  for (const id of userIds) {
    if (await isPlayerRestricted(id)) {
      await interaction.editReply({
        content: `🚫 <@${id}> is restricted from ranked games and cannot be included.`
      });
      return;
    }
  }

// Enhanced parsing to handle commanders assigned to players
const players: PlayerEntry[] = [];

// Helper function to extract and validate turn order + status combinations
function parseStatusAndTurnOrder(token: string): { status?: string; turnOrder?: number } | null {
  // Handle combined formats like "2w", "w2", etc.
  if (/^[1-4][wld]$/i.test(token)) {
    // Format: "2w", "3l", "1d"
    const turnOrder = parseInt(token.charAt(0));
    const status = token.charAt(1).toLowerCase();
    return { status, turnOrder };
  }
  
  if (/^[wld][1-4]$/i.test(token)) {
    // Format: "w2", "l3", "d1"
    const status = token.charAt(0).toLowerCase();
    const turnOrder = parseInt(token.charAt(1));
    return { status, turnOrder };
  }
  
  // Invalid combinations - explicitly reject
  if (/^\d+[wld]\d+$/i.test(token) || // "2w1", "1l3"
      /^[wld]+$/i.test(token) && token.length > 1 || // "ww", "lll"
      /^\d+$/i.test(token) && (parseInt(token) < 1 || parseInt(token) > 4)) { // "0", "5", "99"
    return null; // Explicitly invalid
  }
  
  // Single status
  if (/^[wld]$/i.test(token)) {
    return { status: token.toLowerCase() };
  }
  
  // Single valid turn order
  if (/^[1-4]$/.test(token)) {
    return { turnOrder: parseInt(token) };
  }
  
  return null;
}

// Simple token-by-token parsing approach
const tokens = input.trim().split(/\s+/);
let current: PlayerEntry | null = null;

for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  
  if (/^<@!?\d+>$/.test(token)) {
    // Save previous player if complete
    if (current && current.status) {
      players.push(current);
    }
    
    // Start new player
    current = { userId: token.replace(/\D/g, '') };
    
  } else if (current) {
    // We have a current player, process this token
    
    // First, try to parse as status/turn order combination
    const parsed = parseStatusAndTurnOrder(token);
    if (parsed !== null) {
      if (parsed.status) current.status = parsed.status;
      if (parsed.turnOrder) current.turnOrder = parsed.turnOrder;
      continue;
    }
    
    // Check if it's a commander name
    if (/^[a-zA-Z][a-zA-Z0-9\-',.]*$/.test(token) && token.length > 1 && !current.commander) {
      // Make sure it's not another user mention coming up
      const nextToken = tokens[i + 1];
      const isFollowedByMention = nextToken && /^<@!?\d+>$/.test(nextToken);
      
      if (!isFollowedByMention) {
        current.commander = token;
        current.normalizedCommanderName = normalizeCommanderName(token);
      }
    }
    
  } else {
    // No current player - check for commander-before-mention pattern
    if (/^[a-zA-Z][a-zA-Z0-9\-',.]*$/.test(token) && token.length > 1) {
      // Look ahead for a user mention in the next few tokens
      for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
        if (/^<@!?\d+>$/.test(tokens[j])) {
          // Found a mention - this token is probably a commander name
          // We'll process the mention when we get to it
          break;
        }
      }
    }
  }
}

// CRITICAL FIX: Validate that each player has AT MOST one commander assignment
const playerCommanderCount = new Map<string, number>();
for (const player of players) {
  if (player.commander) {
    const count = (playerCommanderCount.get(player.userId) || 0) + 1;
    playerCommanderCount.set(player.userId, count);
  }
}

// Check for players with multiple commanders
const playersWithMultipleCommanders = Array.from(playerCommanderCount.entries())
  .filter(([_, count]) => count > 1);

if (playersWithMultipleCommanders.length > 0) {
  const problematicPlayers = playersWithMultipleCommanders
    .map(([userId]) => `<@${userId}>`)
    .join(', ');
  
  await interaction.editReply({
    content: `⚠️ Invalid format: Each player can only have ONE commander assigned per game.\n` +
             `The following players have multiple commanders: ${problematicPlayers}\n\n` +
             `Correct format: \`@user commander-name w\` or \`@user w commander-name\`\n` +
             `Incorrect format: \`@user deck1 deck2 w\` or \`@user deck1 w deck2\``
  });
  return;
}

// Don't forget the last player
if (current && current.status) {
  players.push(current);
}

// Handle commander-before-mention pattern: "atraxa @user w"
for (let i = 0; i < tokens.length - 1; i++) {
  const token = tokens[i];
  const nextToken = tokens[i + 1];
  
  if (/^[a-zA-Z][a-zA-Z0-9\-',.]*$/.test(token) && 
      token.length > 1 && 
      /^<@!?\d+>$/.test(nextToken)) {
    
    // This looks like "commander @user" pattern
    const userId = nextToken.replace(/\D/g, '');
    const player = players.find(p => p.userId === userId);
    
    if (player && !player.commander) {
      player.commander = token;
      player.normalizedCommanderName = normalizeCommanderName(token);
    }
  }
}

// Validation: Check for invalid combinations and provide helpful error messages
const invalidPlayers = players.filter(p => !p.status);
if (invalidPlayers.length > 0) {
  await interaction.editReply({
    content: '⚠️ Invalid format detected. Each player must have exactly one result (w/l/d) and optionally one turn order (1-4).\n' +
             'Valid formats: `@user w`, `@user 2 w`, `@user w 3`, `@user 2w`, `@user w2`\n' +
             'Invalid formats: `@user 2w1`, `@user ww`, `@user 5w`, `@user 0l`'
  });
  return;
}

// Check for duplicate turn orders
const assignedTurnOrders = players
  .filter(p => p.turnOrder !== undefined)
  .map(p => p.turnOrder!);

const uniqueTurnOrders = new Set(assignedTurnOrders);
if (assignedTurnOrders.length !== uniqueTurnOrders.size) {
  await interaction.editReply({
    content: '⚠️ Duplicate turn orders detected. Each player must have a unique turn order between 1-4.'
  });
  return;
}

// Debug output
console.log('Input tokens:', tokens);
console.log('Parsed players:', players.map(p => ({
  userId: p.userId,
  status: p.status,
  turnOrder: p.turnOrder,
  commander: p.commander
})));

// Check for any parsing failures and reject invalid tokens
const processedTokens = new Set();
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  
  // Skip user mentions and valid commanders
  if (/^<@!?\d+>$/.test(token) || 
      (/^[a-zA-Z][a-zA-Z0-9\-',.]*$/.test(token) && token.length > 1)) {
    continue;
  }
  
  // Check if this token was successfully parsed
  const parsed = parseStatusAndTurnOrder(token);
  if (parsed === null && !processedTokens.has(token)) {
    await interaction.editReply({
      content: `⚠️ Invalid token detected: "${token}"\n` +
               'Only use: user mentions (@user), commander names, results (w/l/d), and turn orders (1-4).\n' +
               'Valid examples: `w`, `2`, `3w`, `l1`, but NOT `0w`, `5l`, `ww`, `2w3`'
    });
    return;
  }
}

  // SMART TURN ORDER DEDUCTION
  const playersWithTurnOrder = players.filter(p => p.turnOrder !== undefined);
  if (playersWithTurnOrder.length === 3 && players.length === 4) {
    const providedTurnOrders = new Set(playersWithTurnOrder.map(p => p.turnOrder!));
    const allTurnOrders = [1, 2, 3, 4];
    const missingTurnOrder = allTurnOrders.find(t => !providedTurnOrders.has(t));
    
    if (missingTurnOrder) {
      const playerWithoutTurnOrder = players.find(p => p.turnOrder === undefined);
      if (playerWithoutTurnOrder) {
        playerWithoutTurnOrder.turnOrder = missingTurnOrder;
      }
    }
  }

  if (players.length < 2) {
    await interaction.editReply({
      content: '⚠️ You must enter at least two players with results.'
    });
    return;
  }

  // --- CEDH MODE: enforce 4 players, only w/l/d, support optional turn order numbers ---
  const numPlayers = players.length;
  const isCEDHMode = true; // Set to false to disable cEDH mode restrictions
  
  if (isCEDHMode) {
    if (numPlayers !== 4) {
      await interaction.editReply({
        content: '⚠️ Only 4-player games are supported in cEDH mode.'
      });
      return;
    }

    // Prevent duplicate users
    const playerIds = players.map(p => p.userId);
    const uniqueIds = new Set(playerIds);
    if (uniqueIds.size !== playerIds.length) {
      await interaction.editReply({
        content: '⚠️ Duplicate players detected: please list each player only once.'
      });
      return;
    }

    // Ensure each player has w, l, or d
    if (players.some(p => !['w', 'l', 'd'].includes(p.status ?? ''))) {
      await interaction.editReply({
        content: '⚠️ Invalid input: each player must have a result of w (win), l (loss), or d (draw).'
      });
      return;
    }

    // Validate turn order numbers (if provided)
    const providedTurnOrders = players
      .filter(p => p.turnOrder !== undefined)
      .map(p => p.turnOrder!);

    if (providedTurnOrders.length > 0) {
      // Check for valid range (1-4)
      if (providedTurnOrders.some(t => t < 1 || t > 4)) {
        await interaction.editReply({
          content: '⚠️ Turn order numbers must be between 1 and 4.'
        });
        return;
      }

      // Check for duplicates
      const uniqueTurnOrders = new Set(providedTurnOrders);
      if (uniqueTurnOrders.size !== providedTurnOrders.length) {
        await interaction.editReply({
          content: '⚠️ Duplicate turn order numbers detected. Each player must have a unique turn order.'
        });
        return;
      }
    }

    const winCount = players.filter(p => p.status === 'w').length;
    const drawCount = players.filter(p => p.status === 'd').length;
    const lossCount = players.filter(p => p.status === 'l').length;

// Enforce cEDH rules: ONLY 1 winner + 3 losers OR 4 draws
if (winCount === 1 && lossCount === 3 && drawCount === 0) {
  // Valid: 1 winner, 3 losers
} else if (winCount === 0 && lossCount === 0 && drawCount === 4) {
  // Valid: 4-way draw
} else {
  await interaction.editReply({
    content: '⚠️ Invalid result combination for cEDH format. Must be either: 1 winner + 3 losers, or 4 draws.'
  });
  return;
}
  }

  // Validate commanders (if any are assigned)
  const playersWithCommanders = players.filter(p => p.commander);
  if (playersWithCommanders.length > 0) {
    // Get unique commanders for validation
    const uniqueCommanders = [...new Set(playersWithCommanders.map(p => p.normalizedCommanderName!))];

    // Validate all unique commanders exist on EDHREC
    const validationResults = await Promise.all(
      uniqueCommanders.map(async (normalizedName) => ({
        normalizedName,
        valid: (await CommanderValidator.validateCommander(normalizedName)).valid
      }))
    );

    const invalidDecks = validationResults.filter(r => !r.valid);
    if (invalidDecks.length > 0) {
      const invalidNames = invalidDecks.map(r =>
        playersWithCommanders.find(p => p.normalizedCommanderName === r.normalizedName)?.commander
      ).filter(Boolean).join(', ');

      await interaction.editReply({
        content: `⚠️ The following commanders could not be found on EDHREC: ${invalidNames}\n` +
                 'Please check the spelling and use the format from EDHREC URLs (e.g., "atraxa-praetors-voice").'
      });
      return;
    }
  }

  // Admin check
  const isAdmin = hasModAccess(interaction.user.id);
  const submittedByAdmin = isAdmin;

  // Generate unique game ID
  const gameId = await generateUniqueGameId();
  await recordGameId(gameId, 'player');

  // Get game sequence number (for injection or regular)
  let gameSequence: number;
  try {
    gameSequence = await getNextGameSequence(afterGameId || undefined);
  } catch (error) {
    await interaction.editReply({
      content: `⚠️ Error: ${(error as Error).message}`
    });
    return;
  }

  // Store game in master table
  await storeGameInMaster(gameId, gameSequence, interaction.user.id, 'player', submittedByAdmin);

  // Pre-fetch usernames, ratings, and records
  const userNames: Record<string, string> = {};
  const preRatings: Record<string, Rating> = {};
  const records: Record<string, { wins: number; losses: number; draws: number }> = {};
  for (const p of players) {
  try {
    const u = await client.users.fetch(p.userId);
    userNames[p.userId] = `@${u.username}`;
  } catch (error) {
    console.warn(`Failed to fetch username for ${p.userId}:`, error);
    userNames[p.userId] = `<@${p.userId}>`;
  }
  
  try {
    const pd = await getOrCreatePlayer(p.userId);
    preRatings[p.userId] = rating({ mu: pd.mu, sigma: pd.sigma });
    records[p.userId] = {
      wins: pd.wins || 0,
      losses: pd.losses || 0,
      draws: pd.draws || 0
    };
  } catch (error) {
    console.error(`Failed to get player data for ${p.userId}:`, error);
    // Use defaults if database fails
    preRatings[p.userId] = rating({ mu: 25.0, sigma: 8.333 });
    records[p.userId] = { wins: 0, losses: 0, draws: 0 };
  }
}

  // TURN ORDER SUMMARY
  const turnOrderSummary = players
    .filter(p => p.turnOrder !== undefined)
    .map(p => {
      const displayName = userNames[p.userId];
      return `${displayName}: Turn ${p.turnOrder}`;
    });

  // COMMANDER SUMMARY
  const commanderSummary = players
    .filter(p => p.commander)
    .map(p => {
      const displayName = userNames[p.userId];
      return `${displayName}: ${p.commander}`;
    });

  // Add turn order and commander confirmation to embed description
  let additionalInfo = '';
  if (turnOrderSummary.length > 0) {
    additionalInfo += `\n\n🔢 **Turn Order Assigned:**\n${turnOrderSummary.join('\n')}`;
  }
  if (commanderSummary.length > 0) {
    additionalInfo += `\n\n🃃 **Commanders Assigned:**\n${commanderSummary.join('\n')}`;
  }

  // CHECK FOR PLAYERS ALREADY IN LIMBO (skip bot)
  if (!isAdmin) {
    const playersInLimbo: string[] = [];
    const allRelevantUsers = new Set([...players.map(p => p.userId), interaction.user.id]);
    
    // Remove the bot's user ID if it's in the relevant users
    if (client.user?.id) {
      allRelevantUsers.delete(client.user.id);
    }
    
    for (const [messageId, limboPlayerSet] of client.limboGames) {
      for (const userId of allRelevantUsers) {
        if (limboPlayerSet.has(userId)) {
          playersInLimbo.push(userId);
        }
      }
    }
    
    if (playersInLimbo.length > 0) {
      const conflictingMentions = [...new Set(playersInLimbo)].map(id => `<@${id}>`).join(', ');
      await interaction.editReply({
        content: `⚠️ Cannot submit game results. The following players are already in unconfirmed games: ${conflictingMentions}\n\nPlease wait for their current games to be confirmed before submitting new results.`
      });
      return;
    }
  }

  const injectionNote = afterGameId 
  ? afterGameId === '0' 
    ? `\n\n🔥 **Game Pre-Injection**: This game will be placed BEFORE all existing games and all ratings will be recalculated.`
    : `\n\n🔥 **Game Injection**: This game will be inserted after game "${afterGameId}" and all ratings will be recalculated.`
  : '';

  if (submittedByAdmin) {
  // Create admin-specific embed
  const adminEmbed = new EmbedBuilder()
    .setTitle(`⚔️ Game Results Auto Confirmed`)
    .setDescription(
      `✅ **Results submitted by admin. Ratings have been updated immediately.**\n\n` +
      `🎯 **Game ID: ${gameId}**${injectionNote}${additionalInfo}\n\n` +
      'An optional turn order tracking message will appear below for 30 minutes if players want to contribute turn order data.'
    )
    .addFields(
      players.map(p => {
        const r = preRatings[p.userId];
        const rec = records[p.userId];
        const turnOrderDisplay = p.turnOrder ? ` [Turn ${p.turnOrder}]` : '';
        const commanderDisplay = p.commander ? ` 🃃 ${p.commander}` : '';
        return {
          name: `${userNames[p.userId]}${commanderDisplay}${turnOrderDisplay}${p.team ? ` (${p.team})` : ''}`,
          value:
            `Result: ${p.status?.toUpperCase() ?? '❓'}\n` +
            (p.commander ? `Commander: ${p.commander}\n` : '') +
            (p.turnOrder ? `Turn Order: ${p.turnOrder}\n` : '') +
            `Elo: ${calculateElo(r.mu, r.sigma)}\n` +
            `Mu: ${r.mu.toFixed(2)}\n` +
            `Sigma: ${r.sigma.toFixed(2)}\n` +
            `W/L/D: ${rec.wins}/${rec.losses}/${rec.draws}`,
          inline: false
        };
      })
    )
    .setColor(0x00AE86);

  const replyMsg = await interaction.editReply({
    content: `📢 Game results submitted.`,
    embeds: [adminEmbed]
  });

  const matchId = crypto.randomUUID();

  // Process immediately
  await processGameResults(players, preRatings, records, userNames, matchId, gameId, gameSequence, numPlayers, true, interaction.user.id, replyMsg, client, isCEDHMode);
  
  // Handle recalculation if needed
  if (afterGameId) {
    await recalculateAllPlayersFromScratch();
    await recalculateAllDecksFromScratch();

    // Clean up players and decks with 0/0/0 records for consistency
    await cleanupZeroPlayers();
    await cleanupZeroDecks();

    await showTop50PlayersAndDecks(interaction);
  }

  // Handle turn order collection
  const providedTurnOrders = new Set(players.filter(p => p.turnOrder).map(p => p.turnOrder!));
  const missingTurnOrders = [1, 2, 3, 4].filter(t => !providedTurnOrders.has(t));
  const turnOrderEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  
  if (missingTurnOrders.length > 0) {
    try {
      for (const turnOrder of missingTurnOrders) {
        try {
          await replyMsg.react(turnOrderEmojis[turnOrder - 1]);
        } catch (error) {
          console.error(`Failed to add admin reaction for turn order ${turnOrder}:`, error);
        }
      }
    } catch (error) {
      console.error('Failed to add admin turn order reactions:', error);
    }

    const turnOrderSelections = new Map<string, number>();

const turnOrderCollector = replyMsg.createReactionCollector({
  filter: (reaction, user) => !user.bot,
  time: 30 * 60 * 1000
});

// Maintain clean state for admin collector too
const adminCleanTurnOrderState = new Map<string, number>();
const userHasReactedToTurnOrder = new Set<string>(); // Track who has already reacted to turn order

// Add auto-assignment logic for admin games
const checkAndApplyAdminAutoAssignment = () => {
  const playersWithTurnOrder = players.filter(p => p.turnOrder !== undefined || adminCleanTurnOrderState.has(p.userId));
  const playersWithoutTurnOrder = players.filter(p => p.turnOrder === undefined && !adminCleanTurnOrderState.has(p.userId));
  
  // If exactly 3 players have turn orders and 1 doesn't, auto-assign
  if (playersWithTurnOrder.length === 3 && playersWithoutTurnOrder.length === 1) {
    const providedTurnOrders = new Set([
      ...players.filter(p => p.turnOrder !== undefined).map(p => p.turnOrder!),
      ...Array.from(adminCleanTurnOrderState.values())
    ]);
    
    const allTurnOrders = [1, 2, 3, 4];
    const missingTurnOrder = allTurnOrders.find(t => !providedTurnOrders.has(t));
    
    if (missingTurnOrder) {
      const playerWithoutTurnOrder = playersWithoutTurnOrder[0];
      adminCleanTurnOrderState.set(playerWithoutTurnOrder.userId, missingTurnOrder);
      
      return {
        autoAssigned: true,
        player: playerWithoutTurnOrder,
        turnOrder: missingTurnOrder
      };
    }
  }
  
  return { autoAssigned: false };
};

// Updated admin embed update function
const updateAdminEmbedWithTurnOrders = async () => {
  const validUsers = new Set(players.map(p => p.userId));
  
  // Check for auto-assignment
  const autoAssignResult = checkAndApplyAdminAutoAssignment();
  
  const currentTurnOrders = Array.from(adminCleanTurnOrderState.entries())
    .filter(([userId, order]: [string, number]) => validUsers.has(userId) && order > 0)
    .map(([userId, order]: [string, number]) => {
      const isAutoAssigned = autoAssignResult.autoAssigned && 
                            autoAssignResult.player?.userId === userId;
      return `<@${userId}>: Turn ${order}${isAutoAssigned ? ' (auto-assigned)' : ''}`;
    })
    .join(', ');
  
  try {
    const updatedEmbed = EmbedBuilder.from(adminEmbed);
    
    if (currentTurnOrders) {
      let footerText = `Turn orders recorded: ${currentTurnOrders}`;
      
      if (autoAssignResult.autoAssigned) {
        footerText += ` | ✨ Auto-assigned Turn ${autoAssignResult.turnOrder} to <@${autoAssignResult.player!.userId}>`;
      }
      
      updatedEmbed.setFooter({ text: footerText });
    } else {
      updatedEmbed.setFooter({ text: 'Turn order collection period (30 minutes)' });
    }
    
    await replyMsg.edit({ embeds: [updatedEmbed] });
  } catch (error) {
    console.error('Failed to update admin embed with turn order progress:', error);
  }
};

turnOrderCollector.on('collect', async (reaction, user) => {
  // Always remove unauthorized reactions immediately
  const validUsers = new Set(players.map(p => p.userId));
  const turnOrderEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  
  if (!validUsers.has(user.id) || !turnOrderEmojis.includes(reaction.emoji.name!)) {
    try {
      await reaction.users.remove(user.id);
    } catch (error) {
      console.error('Failed to remove unauthorized admin reaction:', error);
    }
    return; // Exit immediately
  }

  // BOUNCER: Check if user has already reacted to turn order once
  if (userHasReactedToTurnOrder.has(user.id)) {
    try {
      await reaction.users.remove(user.id);
    } catch (error) {
      console.error('Failed to remove second admin turn order reaction:', error);
    }
    return;
  }

  const playerHasTurnOrder = players.find(p => p.userId === user.id)?.turnOrder !== undefined;
  if (playerHasTurnOrder) {
    try {
      await reaction.users.remove(user.id);
    } catch (error) {
      console.error('Failed to remove reaction from player with existing turn order:', error);
    }
    return;
  }

  const turnOrder = turnOrderEmojis.indexOf(reaction.emoji.name!) + 1;
  if (!missingTurnOrders.includes(turnOrder)) {
    try {
      await reaction.users.remove(user.id);
    } catch (error) {
      console.error('Failed to remove invalid admin turn order reaction:', error);
    }
    return;
  }

  // Mark user as having reacted to turn order
  userHasReactedToTurnOrder.add(user.id);

  // Update our clean state (not Discord reactions)
  adminCleanTurnOrderState.set(user.id, turnOrder);
  
  // Remove conflicts from our clean state
  for (const [otherUserId, otherOrder] of Array.from(adminCleanTurnOrderState.entries())) {
    if (otherUserId !== user.id && otherOrder === turnOrder) {
      adminCleanTurnOrderState.delete(otherUserId);
      userHasReactedToTurnOrder.delete(otherUserId);
    }
  }

  // Update embed using our clean state only
  await updateAdminEmbedWithTurnOrders();
});

turnOrderCollector.on('end', async (collected, reason) => {
  try {
    if (reason === 'time') {
      // Use our clean state instead of Discord reactions
      const finalTurnOrders: [string, number][] = Array.from(adminCleanTurnOrderState.entries())
        .filter(([userId, order]) => players.some(p => p.userId === userId) && order > 0);

        // Apply any auto-assignments from the collection period
for (const [userId, turnOrder] of adminCleanTurnOrderState.entries()) {
  // Only add if this player didn't already have a turn order from the original command
  const playerHadOriginalTurnOrder = players.find(p => p.userId === userId)?.turnOrder !== undefined;
  if (!playerHadOriginalTurnOrder && !finalTurnOrders.some(([id]) => id === userId)) {
    finalTurnOrders.push([userId, turnOrder]);
  }
}
      
      if (finalTurnOrders.length > 0) {
        console.log(`Updating ${finalTurnOrders.length} turn orders for admin game ${gameId}`);
        for (const [userId, turnOrder] of finalTurnOrders) {
          try {
            await updateMatchTurnOrder(matchId, userId, turnOrder);
          } catch (error) {
            console.error(`Failed to update turn order for user ${userId}:`, error);
          }
        }
      }

      const finalTurnOrderDisplay = finalTurnOrders
        .map(([userId, order]) => `<@${userId}>: Turn ${order}`)
        .join(', ');
      
      const finalEmbed = EmbedBuilder.from(adminEmbed);
      if (finalTurnOrderDisplay) {
        finalEmbed.setFooter({ text: `Final turn orders: ${finalTurnOrderDisplay} (Collection period ended)` });
      } else {
        finalEmbed.setFooter({ text: 'Turn order collection period ended (30 minutes)' });
      }
      
      await replyMsg.edit({ embeds: [finalEmbed] });
    }
  } catch (error) {
    console.error('Error in admin turn order end handler:', error);
  }
});
  }
} else {
  // Non-admin block - properly structured
  const nonAdminEmbed = new EmbedBuilder()
    .setTitle(`⚔️ Game Results Pending Confirmation`)
    .setDescription(
      `**Players must confirm their participation:**\n` +
      '• **FIRST**: Click 1️⃣, 2️⃣, 3️⃣, or 4️⃣ if you want to track your turn order (optional)\n' +
      '• **THEN**: React with 👍 to **confirm** your result\n' +
      '• React with ❌ to **cancel** this game (creator only)\n\n' +
      '**Turn order tracking is optional** - you can use `/setturnorder` later if you forget.\n\n' +
      '💡 **Tip**: You can assign turn order when submitting by adding numbers 1-4 before or after w/l/d.\n' +
      'Example: `/rank @player1 2 w @player2 1 l @player3 4 l @player4 3 l`\n\n' +
      `🎯 **Game ID: ${gameId}**${injectionNote}${additionalInfo}\n\n` +
      '⏰ Game expires in 1 hour if not all players confirm.'
    )
    .addFields(
      players.map(p => {
        const r = preRatings[p.userId];
        const rec = records[p.userId];
        const turnOrderDisplay = p.turnOrder ? ` [Turn ${p.turnOrder}]` : '';
        const commanderDisplay = p.commander ? ` 🃃 ${p.commander}` : '';
        return {
          name: `${userNames[p.userId]}${commanderDisplay}${turnOrderDisplay}${p.team ? ` (${p.team})` : ''}`,
          value:
            `Result: ${p.status?.toUpperCase() ?? '❓'}\n` +
            (p.commander ? `Commander: ${p.commander}\n` : '') +
            (p.turnOrder ? `Turn Order: ${p.turnOrder}\n` : '') +
            `Elo: ${calculateElo(r.mu, r.sigma)}\n` +
            `Mu: ${r.mu.toFixed(2)}\n` +
            `Sigma: ${r.sigma.toFixed(2)}\n` +
            `W/L/D: ${rec.wins}/${rec.losses}/${rec.draws}`,
          inline: false
        };
      })
    )
    .setColor(0x00AE86);

  const pinged = players.map(p => `<@${p.userId}>`).join(' ');
  const replyMsg = await interaction.editReply({
    content: `📢 Game results submitted. Waiting for confirmations from: ${pinged}`,
    embeds: [nonAdminEmbed]
  });

  const matchId = crypto.randomUUID();
    // Non-admin: wait for confirmations with enhanced reaction system
    const pending = new Set(players.map(p => p.userId));
    // Remove the bot from pending confirmations - it can't confirm itself
    if (client.user?.id) {
      pending.delete(client.user.id);
    }
    
    try {
  // Add all reaction options
  await replyMsg.react('👍');
  await replyMsg.react('❌'); // Cancel option
  
  // Add turn order reactions only for positions not already specified
  const providedTurnOrders = new Set(players.filter(p => p.turnOrder).map(p => p.turnOrder!));
  const missingTurnOrders = [1, 2, 3, 4].filter(t => !providedTurnOrders.has(t));
  const turnOrderEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  
  // Only add turn order reactions if there are missing turn orders
  if (missingTurnOrders.length > 0) {
    for (const turnOrder of missingTurnOrders) {
      try {
        await replyMsg.react(turnOrderEmojis[turnOrder - 1]);
      } catch (error) {
        console.error(`Failed to add reaction for turn order ${turnOrder}:`, error);
      }
    }
  }
} catch (error) {
  console.error('Failed to add basic reactions:', error);
  // Continue execution even if reactions fail
}


    // Track players in limbo (exclude the bot)
    const limboUsers = new Set(players.map(p => p.userId).filter(id => id !== client.user?.id));
    if (players.map(p => p.userId).includes(interaction.user.id)) {
      limboUsers.add(interaction.user.id);
    }
    client.limboGames.set(replyMsg.id, limboUsers);

    // Track turn order selections
    const turnOrderSelections = new Map<string, number>();

 const providedTurnOrders = new Set(players.filter(p => p.turnOrder).map(p => p.turnOrder!));
const missingTurnOrders = [1, 2, 3, 4].filter(t => !providedTurnOrders.has(t));

// Replace the non-admin collector with this approach that maintains its own state
const collector = replyMsg.createReactionCollector({
  filter: (reaction, user) => !user.bot,
  time: 60 * 60 * 1000
});

// Add processing flag to prevent double processing
let isProcessing = false;

// Maintain our own clean state - ignore Discord reactions for display
const cleanTurnOrderState = new Map<string, number>();
const userHasReactedToTurnOrder = new Set<string>(); // Track who has already reacted to turn order

// Add this function for auto-assignment logic
const checkAndApplyAutoAssignment = () => {
  const playersWithTurnOrder = players.filter(p => p.turnOrder !== undefined || cleanTurnOrderState.has(p.userId));
  const playersWithoutTurnOrder = players.filter(p => p.turnOrder === undefined && !cleanTurnOrderState.has(p.userId));
  
  // If exactly 3 players have turn orders and 1 doesn't, auto-assign
  if (playersWithTurnOrder.length === 3 && playersWithoutTurnOrder.length === 1) {
    const providedTurnOrders = new Set([
      ...players.filter(p => p.turnOrder !== undefined).map(p => p.turnOrder!),
      ...Array.from(cleanTurnOrderState.values())
    ]);
    
    const allTurnOrders = [1, 2, 3, 4];
    const missingTurnOrder = allTurnOrders.find(t => !providedTurnOrders.has(t));
    
    if (missingTurnOrder) {
      const playerWithoutTurnOrder = playersWithoutTurnOrder[0];
      cleanTurnOrderState.set(playerWithoutTurnOrder.userId, missingTurnOrder);
      
      return {
        autoAssigned: true,
        player: playerWithoutTurnOrder,
        turnOrder: missingTurnOrder
      };
    }
  }
  
  return { autoAssigned: false };
};

// Updated embed update function that shows auto-assignments
const updateEmbedWithTurnOrders = async () => {
  const validUsers = new Set(players.map(p => p.userId));
  
  // Check for auto-assignment
  const autoAssignResult = checkAndApplyAutoAssignment();
  
  const currentTurnOrders = Array.from(cleanTurnOrderState.entries())
    .filter(([userId, order]: [string, number]) => validUsers.has(userId) && order > 0)
    .map(([userId, order]: [string, number]) => {
      const isAutoAssigned = autoAssignResult.autoAssigned && 
                            autoAssignResult.player?.userId === userId;
      return `<@${userId}>: Turn ${order}${isAutoAssigned ? ' (auto-assigned)' : ''}`;
    })
    .join(', ');
  
  try {
    const updatedEmbed = EmbedBuilder.from(nonAdminEmbed);
    
    if (currentTurnOrders) {
      let footerText = `Turn orders recorded: ${currentTurnOrders}`;
      
      if (autoAssignResult.autoAssigned) {
        footerText += `\n\n✨ Auto-assigned Turn ${autoAssignResult.turnOrder} to <@${autoAssignResult.player!.userId}> (3/4 orders provided)`;
      }
      
      updatedEmbed.setFooter({ text: footerText });
    } else {
      updatedEmbed.setFooter(null);
    }
    
    await replyMsg.edit({ embeds: [updatedEmbed] });
  } catch (error) {
    console.error('Failed to update embed:', error);
  }
};

collector.on('collect', async (reaction, user) => {
  // Always remove unauthorized reactions immediately
  const validUsers = new Set(players.map(p => p.userId));
  validUsers.add(interaction.user.id);
  const validEmojis = ['👍', '❌', '1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  
  if (!validUsers.has(user.id) || !validEmojis.includes(reaction.emoji.name!)) {
    try {
      await reaction.users.remove(user.id);
    } catch (error) {
      console.error('Failed to remove unauthorized reaction:', error);
    }
    return; // Exit immediately - don't process anything
  }

  // Handle cancellation
  if (reaction.emoji.name === '❌' && user.id === interaction.user.id) {
    try {
      if (isProcessing) return; // Prevent cancellation during processing
      collector.stop('cancelled');
      client.limboGames.delete(replyMsg.id);
      
      const cancelEmbed = new EmbedBuilder()
        .setTitle('❌ Game Cancelled')
        .setDescription('The game creator has cancelled this pending game.')
        .setColor(0xFF0000);
      
      const chan = replyMsg.channel as TextChannel;
      await chan.send({ 
        content: `🚫 **Game Cancelled**: Game ID ${gameId} was cancelled by the submitter.`,
        embeds: [cancelEmbed] 
      });
      return;
    } catch (error) {
      console.error('Error in cancellation handler:', error);
      return;
    }
  }

  // Handle confirmation - ALLOW all game participants to confirm
  if (reaction.emoji.name === '👍' && pending.has(user.id)) {
    pending.delete(user.id);
    
    // Apply auto-assignment if applicable before checking completion
    checkAndApplyAutoAssignment();
    
    // Update embed to show current confirmation status
    try {
      if (pending.size > 0) {
        const remainingUsers = Array.from(pending).map(id => `<@${id}>`).join(', ');
        const updatedContent = `📢 Game results submitted. Waiting for confirmations from: ${remainingUsers}`;
        await interaction.editReply({ content: updatedContent });
      }
    } catch (error) {
      console.error('Failed to update confirmation status:', error);
    }
    
    // CRITICAL FIX: Add processing guard
    if (pending.size === 0 && !isProcessing) {
      isProcessing = true; // Set flag immediately
      
      try {
        collector.stop('confirmed');
        client.limboGames.delete(replyMsg.id);

        // Use our clean state instead of reading from Discord reactions
        for (const player of players) {
          if (!player.turnOrder && cleanTurnOrderState.has(player.userId)) {
            player.turnOrder = cleanTurnOrderState.get(player.userId);
          }
        }

        // Auto-assign logic
        const playersWithTurnOrder = players.filter(p => p.turnOrder !== undefined);
        const playersWithoutTurnOrder = players.filter(p => p.turnOrder === undefined);
        
        if (playersWithTurnOrder.length === 3 && playersWithoutTurnOrder.length === 1) {
          const finalProvidedTurnOrders = new Set(playersWithTurnOrder.map(p => p.turnOrder!));
          const allTurnOrders = [1, 2, 3, 4];
          const finalMissingTurnOrder = allTurnOrders.find(t => !finalProvidedTurnOrders.has(t));
          
          if (finalMissingTurnOrder) {
            playersWithoutTurnOrder[0].turnOrder = finalMissingTurnOrder;
          }
        }

        await processGameResults(players, preRatings, records, userNames, matchId, gameId, gameSequence, numPlayers, false, interaction.user.id, replyMsg, client, isCEDHMode);
        
        if (afterGameId) {
          await recalculateAllPlayersFromScratch();
          await recalculateAllDecksFromScratch();

          // Clean up players and decks with 0/0/0 records for consistency
          await cleanupZeroPlayers();
          await cleanupZeroDecks();

          await showTop50PlayersAndDecks(interaction);
        }
      } catch (error) {
        console.error('Error processing game results:', error);
        isProcessing = false; // Reset flag on error
        throw error; // Re-throw to handle properly
      }
    }
    return;
  }

  // Handle turn order reactions with bouncer for turn order only
  const turnOrderEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  if (turnOrderEmojis.includes(reaction.emoji.name!)) {
    // BOUNCER: Check if user has already reacted to turn order once
    if (userHasReactedToTurnOrder.has(user.id)) {
      try {
        await reaction.users.remove(user.id);
      } catch (error) {
        console.error('Failed to remove second turn order reaction:', error);
      }
      return;
    }

    const isParticipant = players.some(p => p.userId === user.id);
    const playerHasTurnOrder = players.find(p => p.userId === user.id)?.turnOrder !== undefined;
    
    if (!isParticipant || playerHasTurnOrder) {
      try {
        await reaction.users.remove(user.id);
      } catch (error) {
        console.error('Failed to remove invalid turn order reaction:', error);
      }
      return;
    }

    const turnOrder = turnOrderEmojis.indexOf(reaction.emoji.name!) + 1;
    const currentProvidedTurnOrders = new Set(players.filter(p => p.turnOrder).map(p => p.turnOrder!));
    const currentMissingTurnOrders = [1, 2, 3, 4].filter(t => !currentProvidedTurnOrders.has(t));
    
    if (!currentMissingTurnOrders.includes(turnOrder)) {
      try {
        await reaction.users.remove(user.id);
      } catch (error) {
        console.error('Failed to remove unavailable turn order reaction:', error);
      }
      return;
    }

    // Mark user as having reacted to turn order
    userHasReactedToTurnOrder.add(user.id);

    // Update our clean state (not Discord reactions)
    cleanTurnOrderState.set(user.id, turnOrder);
    
    // Remove conflicts from our clean state
    for (const [otherUserId, otherOrder] of Array.from(cleanTurnOrderState.entries())) {
      if (otherUserId !== user.id && otherOrder === turnOrder) {
        cleanTurnOrderState.delete(otherUserId);
      }
    }

    // Update embed using our clean state only
    await updateEmbedWithTurnOrders();
  }
});
collector.on('end', async (collected, reason) => {
  try {
    if (reason === 'time') {
      client.limboGames.delete(replyMsg.id);
      
      const timeoutEmbed = new EmbedBuilder()
        .setTitle('⏰ Game Expired')
        .setDescription('This game timed out after 1 hour without all players confirming.')
        .setColor(0xFF6B6B);
      
      const timeoutMsg = `⏰ **Game Expired**: ${pinged} - Your pending game timed out after 1 hour without full confirmation.`;
      const chan = replyMsg.channel as TextChannel;
      
      try {
        await chan.send({ content: timeoutMsg, embeds: [timeoutEmbed] });
      } catch (error) {
        console.error('Failed to send timeout notification:', error);
      }
    } else if (reason === 'cancelled') {
      return;
    }
  } catch (error) {
    console.error('Error in collector end handler:', error);
  }
});
}}

// Separate function for deck-only mode
async function executeDeckOnlyMode(
  interaction: ChatInputCommandInteraction,
  client: ExtendedClient,
  input: string,
  afterGameId: string | null
): Promise<void> {
  // Parse input: commander-name followed by w/l/d
  const tokens = input.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length % 2 !== 0) {
    await interaction.editReply({
      content: '⚠️ Invalid format for deck-only mode. Use: `commander-name w/l/d commander-name w/l/d ...`\n' +
               'Example: `atraxa-praetors-voice l edgar-markov w kaalia-of-the-vast l edgar-markov w`\n' +
               'Note: Duplicate commanders are allowed.'
    });
    return;
  }

  const decks: DeckEntry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const commanderName = tokens[i];
    const result = tokens[i + 1]?.toLowerCase();

    if (!['w', 'l', 'd'].includes(result)) {
      await interaction.editReply({
        content: `⚠️ Invalid result "${result}" for ${commanderName}. Use w (win), l (loss), or d (draw).`
      });
      return;
    }

    const normalizedName = normalizeCommanderName(commanderName);
    decks.push({
      commander: commanderName,
      normalizedName,
      status: result as 'w' | 'l' | 'd',
      turnOrder: (i / 2) + 1 // Turn order based on position in input
    });
  }

  // Validate deck count (3-4 players for cEDH)
  if (![3, 4].includes(decks.length)) {
    await interaction.editReply({
      content: '⚠️ Only 3-deck or 4-deck games are supported in cEDH mode.'
    });
    return;
  }

  const winCount = decks.filter(d => d.status === 'w').length;
const drawCount = decks.filter(d => d.status === 'd').length; 
const lossCount = decks.filter(d => d.status === 'l').length;

// Enforce cEDH rules: ONLY 1 winner + remaining losers OR all draws
if (decks.length === 4) {
  if (winCount === 1 && lossCount === 3 && drawCount === 0) {
    // Valid: 1 winner, 3 losers
  } else if (winCount === 0 && lossCount === 0 && drawCount === 4) {
    // Valid: 4-way draw
  } else {
    await interaction.editReply({
      content: '⚠️ Invalid result combination for cEDH format. Must be either: 1 winner + 3 losers, or 4 draws.'
    });
    return;
  }
} else if (decks.length === 3) {
  if (winCount === 1 && lossCount === 2 && drawCount === 0) {
    // Valid: 1 winner, 2 losers
  } else if (winCount === 0 && lossCount === 0 && drawCount === 3) {
    // Valid: 3-way draw
  } else {
    await interaction.editReply({
      content: '⚠️ Invalid result combination for 3-deck cEDH format. Must be either: 1 winner + 2 losers, or 3 draws.'
    });
    return;
  }
}

  // Generate unique game ID
  const gameId = await generateUniqueGameId();
  await recordGameId(gameId, 'deck');

  // Get game sequence number (for injection or regular)
  let gameSequence: number;
  try {
    gameSequence = await getNextGameSequence(afterGameId || undefined);
  } catch (error) {
    await interaction.editReply({
      content: `⚠️ Error: ${(error as Error).message}`
    });
    return;
  }

  // Admin check for deck-only mode
  const isAdmin = hasModAccess(interaction.user.id);
  const submittedByAdmin = isAdmin;

  // Store game in master table
  await storeGameInMaster(gameId, gameSequence, interaction.user.id, 'deck', submittedByAdmin);

  // Get unique commanders for validation (avoid validating duplicates multiple times)
  const uniqueCommanders = [...new Set(decks.map(d => d.normalizedName))];
  
  // Validate all unique commanders exist on EDHREC
  const validationResults = await Promise.all(
    uniqueCommanders.map(async (normalizedName) => ({
      normalizedName,
      valid: (await CommanderValidator.validateCommander(normalizedName)).valid
    }))
  );

  const invalidDecks = validationResults.filter(r => !r.valid);
  if (invalidDecks.length > 0) {
    const invalidNames = invalidDecks.map(r => 
      decks.find(d => d.normalizedName === r.normalizedName)?.commander
    ).filter(Boolean).join(', ');
    
    await interaction.editReply({
      content: `⚠️ The following commanders could not be found on EDHREC: ${invalidNames}\n` +
               'Please check the spelling and use the format from EDHREC URLs (e.g., "atraxa-praetors-voice").'
    });
    return;
  }

  // Pre-fetch deck ratings and records for unique decks only
  const deckRatings: Record<string, Rating> = {};
  const deckRecords: Record<string, { wins: number; losses: number; draws: number }> = {};
  
  for (const normalizedName of uniqueCommanders) {
    const displayName = decks.find(d => d.normalizedName === normalizedName)?.commander || normalizedName;
    const deckData = await getOrCreateDeck(normalizedName, displayName);
    deckRatings[normalizedName] = rating({ mu: deckData.mu, sigma: deckData.sigma });
    deckRecords[normalizedName] = {
      wins: deckData.wins || 0,
      losses: deckData.losses || 0,
      draws: deckData.draws || 0
    };
  }

  const injectionNote = afterGameId 
  ? afterGameId === '0' 
    ? `\n\n🔥 **Game Pre-Injection**: This game will be placed BEFORE all existing games and all ratings will be recalculated.`
    : `\n\n🔥 **Game Injection**: This game will be inserted after game "${afterGameId}" and all ratings will be recalculated.`
  : '';

  // Count duplicates for display
  const deckCounts = decks.reduce((acc, deck) => {
    acc[deck.normalizedName] = (acc[deck.normalizedName] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Initial embed showing the decks
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Deck Battle Results - ${isAdmin ? 'Auto Confirmed' : 'Awaiting Confirmation'}`)
    .setDescription(
      isAdmin
        ? `✅ **Results submitted by admin. Deck ratings have been updated immediately.**\n\n` +
          `🎯 **Game ID: ${gameId}**${injectionNote}`
        : 'Please react with 👍 to confirm these deck results. Any 2 people can confirm.\n\n' +
          `🎯 **Game ID: ${gameId}**${injectionNote}`
    )
    .addFields(
      decks.map((deck, index) => {
        const r = deckRatings[deck.normalizedName];
        const rec = deckRecords[deck.normalizedName];
        const duplicateNote = deckCounts[deck.normalizedName] > 1 ? ` (${deckCounts[deck.normalizedName]} copies in this game)` : '';
        
        return {
          name: `Turn ${deck.turnOrder}: ${deck.commander}${duplicateNote}`,
          value:
            `Result: ${deck.status.toUpperCase()}\n` +
            `Current Elo: ${calculateElo(r.mu, r.sigma)}\n` +
            `Current Mu: ${r.mu.toFixed(2)}\n` +
            `Current Sigma: ${r.sigma.toFixed(2)}\n` +
            `Current W/L/D: ${rec.wins}/${rec.losses}/${rec.draws}`,
          inline: true
        };
      })
    )
    .setColor(0x9932CC);

  const replyMsg = await interaction.editReply({
    content: isAdmin
      ? '🔥 Deck battle results confirmed by admin.'
      : '📢 Deck battle results submitted. Waiting for confirmations from at least 2 people.',
    embeds: [embed]
  });

  const matchId = crypto.randomUUID();

  if (isAdmin) {
    // Admin path - process immediately
    await processDeckResults(decks, deckRatings, deckRecords, matchId, gameId, gameSequence, submittedByAdmin, interaction.user.id, replyMsg);
    
    // If this was a deck game injection, recalculate all ratings
    if (afterGameId) {
      await recalculateAllPlayersFromScratch();
      await recalculateAllDecksFromScratch();

      // Clean up players and decks with 0/0/0 records for consistency
      await cleanupZeroPlayers();
      await cleanupZeroDecks();
    }
  } else {
    // Add reactions for confirmation and cancellation
    await replyMsg.react('👍');
    await replyMsg.react('❌'); // Add cancel option

    // Add processing flag to prevent double processing for deck battles
    let isProcessingDeck = false;

    // Track confirmations (any 2 people can confirm)
    const confirmations = new Set<string>();
    const requiredConfirmations = 2;

    // Track this game in limbo
    client.limboGames.set(replyMsg.id, new Set([interaction.user.id]));

    const collector = replyMsg.createReactionCollector({
      filter: (reaction, user) =>
        (reaction.emoji.name === '👍' || reaction.emoji.name === '❌') && !user.bot,
      time: 60 * 60 * 1000 // 1 hour timeout
    });

    collector.on('collect', async (reaction, user) => {
      // Handle cancellation (only submitter can cancel)
      if (reaction.emoji.name === '❌' && user.id === interaction.user.id) {
        try {
          collector.stop('cancelled');
          client.limboGames.delete(replyMsg.id);
          
          // Notify that deck battle was cancelled
          const cancelEmbed = new EmbedBuilder()
            .setTitle('❌ Deck Battle Cancelled')
            .setDescription('The deck battle submitter has cancelled this pending game.')
            .setColor(0xFF0000);
          
          const cancelMsg = `🚫 **Deck Battle Cancelled**: Game ID ${gameId} - Your pending deck battle was cancelled by the submitter.`;
          const chan = replyMsg.channel as TextChannel;
          
          try {
            await chan.send({ content: cancelMsg, embeds: [cancelEmbed] });
          } catch (error) {
            console.error('Failed to send deck battle cancellation notification:', error);
          }
          return;
        } catch (error) {
          console.error('Error handling deck battle cancellation:', error);
          return;
        }
      }

      // Handle confirmation
      if (reaction.emoji.name === '👍') {
        confirmations.add(user.id);
        
        // Update the embed to show progress
        const updatedEmbed = EmbedBuilder.from(embed)
          .setTitle('⚔️ Deck Battle Results - Awaiting Confirmation')
          .setDescription(
            `Please react with 👍 to confirm these deck results. Any 2 people can confirm.\n` +
            `React with ❌ to cancel this deck battle (submitter only).\n\n` +
            `🎯 **Game ID: ${gameId}**${injectionNote}\n\n` +
            `✅ **Confirmations: ${confirmations.size}/${requiredConfirmations}**`
          );
        
        await replyMsg.edit({ embeds: [updatedEmbed] });
        
        // CRITICAL FIX: Add processing guard for deck battles too
        if (confirmations.size >= requiredConfirmations && !isProcessingDeck) {
          isProcessingDeck = true; // Set flag immediately
          
          try {
            collector.stop('confirmed');
            client.limboGames.delete(replyMsg.id);

            // Process deck results (submittedByAdmin is false for non-admin path)
            await processDeckResults(decks, deckRatings, deckRecords, matchId, gameId, gameSequence, false, interaction.user.id, replyMsg);
            
            // If this was a deck game injection, recalculate all ratings
            if (afterGameId) {
              await recalculateAllPlayersFromScratch();
              await recalculateAllDecksFromScratch();

              // Clean up players and decks with 0/0/0 records for consistency
              await cleanupZeroPlayers();
              await cleanupZeroDecks();
            }
          } catch (error) {
            console.error('Error processing deck results:', error);
            isProcessingDeck = false; // Reset flag on error
            throw error;
          }
        }
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason === 'time') {
        client.limboGames.delete(replyMsg.id);
        
        const timeoutEmbed = new EmbedBuilder()
          .setTitle('⏰ Deck Battle Expired')
          .setDescription('This deck battle timed out after 1 hour without sufficient confirmations.')
          .setColor(0xFF6B6B);
        
        const timeoutMsg = `⏰ **Deck Battle Expired**: Game ID ${gameId} - Your pending deck battle timed out after 1 hour without sufficient confirmations.`;
        
        try {
          const chan = replyMsg.channel as TextChannel;
          await chan.send({ content: timeoutMsg, embeds: [timeoutEmbed] });
        } catch (error) {
          console.error('Failed to send deck battle timeout notification:', error);
        }
      } else if (reason === 'cancelled') {
        // Already handled in the collect event
        return;
      }
    });
  }
}

async function processGameResults(
  players: PlayerEntry[],
  preRatings: Record<string, Rating>,
  records: Record<string, any>,
  userNames: Record<string, string>,
  matchId: string,
  gameId: string,
  gameSequence: number,
  numPlayers: number,
  submittedByAdmin: boolean,
  submitterId: string,
  replyMsg: any,
  client: any,
  isCEDHMode: boolean
): Promise<string[]> {
  // Note: We don't reset timewalk here - the per-player check handles this
  // Players who just played won't have cumulative timewalk days applied to them

  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const prs = players.map(p => ({
    ...p,
    key: typeof p.score === 'number' ? `score:${p.score}` : `status:${p.status}`
  }));
  
  const sortCopy = [...prs].sort((a, b) => {
    if (typeof a.score === 'number' && typeof b.score === 'number') {
      return b.score - a.score;
    }
    if (a.status && b.status) {
      return (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
    }
    return 0;
  });
  
  const ranks: number[] = [];
  let cr = 1;
  for (let i = 0; i < sortCopy.length; i++) {
    if (i > 0 && sortCopy[i].key !== sortCopy[i - 1].key) cr = i + 1;
    ranks[players.findIndex(p => p.userId === sortCopy[i].userId)] = cr;
  }

  const ordered = players.map(p => [preRatings[p.userId]]);
  let newMatrix = rate(ordered, { rank: ranks });
  
  // Apply 3-player penalty if in cEDH mode
  if (isCEDHMode && numPlayers === 3) {
    newMatrix = newMatrix.map(rating => {
      const newRating = rating[0];
      const adjustedMu = 25 + (newRating.mu - 25) * 0.9;
      return [{ mu: adjustedMu, sigma: newRating.sigma }];
    });
  }
  
  const results: string[] = [];

// FIXED: Auto-apply default decks ONLY for players without commanders AND only for FUTURE games
for (const player of players) {
  if (!player.commander) {
    // Query default deck directly from database
    const { getDatabase } = await import('../db/init.js');
    const db = getDatabase();
    
    // Check if this is a NEW game (being submitted now) or an OLD game (already exists)
    const existingMatch = await db.get(
      'SELECT assignedDeck FROM matches WHERE userId = ? AND gameId = ?',
      player.userId,
      gameId
    );
    
    // CRITICAL: Only auto-apply default deck if this is a NEW game submission
    // Do NOT auto-apply for existing games (replays, recalculations, etc.)
    if (!existingMatch) {
      const playerData = await db.get('SELECT defaultDeck FROM players WHERE userId = ?', player.userId);
      
      if (playerData?.defaultDeck) {
        // Get the display name for the default deck
        const deckData = await getOrCreateDeck(playerData.defaultDeck, playerData.defaultDeck);
        player.commander = deckData.displayName;
        player.normalizedCommanderName = playerData.defaultDeck;
        
        console.log(`[AUTO-ASSIGN] Applied default deck ${player.commander} to ${player.userId} for new game ${gameId}`);
      }
    } else if (existingMatch.assignedDeck) {
      // This is an existing game - use whatever deck was ALREADY assigned
      const deckData = await db.get('SELECT displayName FROM decks WHERE normalizedName = ?', existingMatch.assignedDeck);
      player.commander = deckData?.displayName || existingMatch.assignedDeck;
      player.normalizedCommanderName = existingMatch.assignedDeck;
      
      console.log(`[EXISTING] Preserved existing deck ${player.commander} for ${player.userId} in game ${gameId}`);
    }
  }
}


  // ENHANCED: Process commanders if any are assigned
  const playersWithCommanders = players.filter(p => p.commander);
  if (playersWithCommanders.length > 0) {
    await processCommanderRatingsEnhanced(playersWithCommanders, players, gameId, matchId);
  }

  // Track final ratings (including participation bonus) for snapshot
  const finalRatings: Record<string, Rating> = {};

  // Process player ratings (existing logic)
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const oldR = preRatings[p.userId];
    let newR = newMatrix[i][0];

    // Declare variables for display outside try block
    const oldElo = calculateElo(oldR.mu, oldR.sigma);
    let preBonusElo = oldElo;
    let finalElo = oldElo;
    let ratingChange = 0;
    let changeSign = '+';

    try {
      // Step 1: Apply minimum rating change guarantee
      newR = ensureMinimumRatingChange(oldR, newR, p.status!);

      // Capture pre-bonus Elo for display
      preBonusElo = calculateElo(newR.mu, newR.sigma);
      ratingChange = preBonusElo - oldElo;
      changeSign = ratingChange >= 0 ? '+' : '';

      // Step 2: Apply participation bonus (+1 Elo for playing ranked)
      newR = applyParticipationBonus(newR);

      // Track final rating for snapshot
      finalRatings[p.userId] = newR;

      // Calculate final Elo for display
      finalElo = calculateElo(newR.mu, newR.sigma);

      const rec = records[p.userId];
      if (p.status === 'w') rec.wins++;
      else if (p.status === 'l') rec.losses++;
      else if (p.status === 'd') rec.draws++;

      await updatePlayerRating(p.userId, newR.mu, newR.sigma, rec.wins, rec.losses, rec.draws);

      // Record player activity for virtual clock (timewalk) tracking
      recordPlayerActivity(p.userId);

      await recordMatch(
        matchId, 
        gameId,
        p.userId, 
        p.status ?? 'd', 
        new Date(), 
        newR.mu, 
        newR.sigma, 
        [], 
        [], 
        p.score, 
        submittedByAdmin,
        p.turnOrder,
        p.normalizedCommanderName || null  // CRITICAL: Pass the normalized commander name
      );
    } catch (error) {
      console.error(`Failed to update player ${p.userId} rating/match:`, error);
    }

    // Log the rating change for audit trail
    try {
      await logRatingChange({
        targetType: 'player',
        targetId: p.userId,
        targetDisplayName: userNames[p.userId],
        changeType: 'game',
        oldMu: oldR.mu,
        oldSigma: oldR.sigma,
        oldElo: calculateElo(oldR.mu, oldR.sigma),
        newMu: newR.mu,
        newSigma: newR.sigma,
        newElo: calculateElo(newR.mu, newR.sigma),
        parameters: JSON.stringify({
          gameId: gameId,
          result: p.status,
          turnOrder: p.turnOrder,
          opponents: players.length - 1,
          submittedByAdmin: submittedByAdmin,
          commander: p.commander || null
        })
      });
    } catch (auditError) {
      console.error('Error logging player rating change to audit trail:', auditError);
    }

    const commanderInfo = p.commander ? ` [${p.commander}]` : '';
    results.push(
      `${userNames[p.userId]}${p.team ? ` (${p.team})` : ''}${p.turnOrder ? ` [Turn ${p.turnOrder}]` : ''}${commanderInfo}\n` +
        `Elo: ${oldElo} → ${preBonusElo} (${changeSign}${ratingChange}) + 1 (participation) = **${finalElo}**\n` +
        `Mu: ${oldR.mu.toFixed(2)} → ${newR.mu.toFixed(2)} | Sigma: ${oldR.sigma.toFixed(2)} → ${newR.sigma.toFixed(2)}\n` +
        `W/L/D: ${records[p.userId].wins}/${records[p.userId].losses}/${records[p.userId].draws}`
    );
  }

  // Update matches with sequence number
  await updateMatchesWithSequence(gameId, gameSequence, 'player');

  // Build complete match data for snapshot (needed for proper undo/redo)
  const matchDataForSnapshot = players.map(p => ({
    id: matchId,
    gameId: gameId,
    userId: p.userId,
    status: p.status ?? 'd',
    matchDate: new Date().toISOString(),
    mu: finalRatings[p.userId].mu,
    sigma: finalRatings[p.userId].sigma,
    teams: JSON.stringify([]),
    scores: JSON.stringify([]),
    score: p.score ?? 0,
    submittedByAdmin: submittedByAdmin,
    turnOrder: p.turnOrder ?? null,
    assignedDeck: p.normalizedCommanderName || null,
    submittedBy: submitterId
  }));

  await saveMatchSnapshot({
    matchId,
    gameId,
    gameSequence,
    gameType: 'player',
    matchData: matchDataForSnapshot,
    before: players.map(p => ({
      userId: p.userId,
      mu: preRatings[p.userId].mu,
      sigma: preRatings[p.userId].sigma,
      wins: records[p.userId].wins - (players.find(x => x.userId === p.userId)?.status === 'w' ? 1 : 0),
      losses: records[p.userId].losses - (players.find(x => x.userId === p.userId)?.status === 'l' ? 1 : 0),
      draws: records[p.userId].draws - (players.find(x => x.userId === p.userId)?.status === 'd' ? 1 : 0),
      tag: userNames[p.userId],
      turnOrder: p.turnOrder,
      commander: p.commander || undefined
    })),
    after: players.map((p) => ({
      userId: p.userId,
      mu: finalRatings[p.userId].mu,
      sigma: finalRatings[p.userId].sigma,
      wins: records[p.userId].wins,
      losses: records[p.userId].losses,
      draws: records[p.userId].draws,
      tag: userNames[p.userId],
      turnOrder: p.turnOrder,
      commander: p.commander || undefined
    }))
  });

  const resultEmbed = new EmbedBuilder()
    .setTitle('✅ All players have confirmed. Results are now final!')
    .setDescription(`🎯 **Game ID: ${gameId}**\n\n` + results.join('\n\n'))
    .setColor(0x4BB543);

  const chan = replyMsg.channel as TextChannel;
  await chan.send({ embeds: [resultEmbed] });

  // Check for suspicious activity (but skip the bot)
  for (const p of players.filter(p => p.status === 'w' && p.userId !== client.user?.id)) {
    const alert = await checkForSuspiciousPatterns(p.userId, submittedByAdmin);
    if (!alert) continue;

    const alertRecipients = [...config.admins, ...config.moderators];
for (const recipientId of alertRecipients) {
  if (!(await getAlertOptIn(recipientId))) continue;
  try {
    const user = await client.users.fetch(recipientId);
    await user.send(alert);
  } catch {}
}
  }
  
  return results;
}

// Process commander ratings with phantom opponents
// ENHANCED: New function that processes commander ratings with phantoms, allowing unassigned turn orders
export async function processCommanderRatingsEnhanced(
  playersWithCommanders: PlayerEntry[],
  allPlayers: PlayerEntry[],
  gameId: string,
  matchId: string
): Promise<void> {
  // Create commander entries with flexible turn order assignment
  const commanderEntries: any[] = [];
  
  // Add real commanders - use their assigned turn order OR fallback to position
  for (const player of playersWithCommanders) {
    const playerIndex = allPlayers.findIndex(p => p.userId === player.userId);
    
    commanderEntries.push({
      commander: player.commander!,
      normalizedName: player.normalizedCommanderName!,
      status: player.status!,
      turnOrder: player.turnOrder !== undefined ? player.turnOrder : (playerIndex + 1),
      isPhantom: false,
      originalPlayer: player.userId
    });
  }
  
  // Add phantom commanders to fill to 4
  const phantomCount = 4 - commanderEntries.length;
  const phantomMu = 25.0;
  const phantomSigma = 8.333;
  
  for (let i = 0; i < phantomCount; i++) {
    const phantomTurnOrder = findAvailableTurnOrderForPhantoms(commanderEntries);
    commanderEntries.push({
      commander: `phantom-${i + 1}`,
      normalizedName: `phantom-${i + 1}`,
      status: 'l', // Phantoms always lose
      turnOrder: phantomTurnOrder,
      isPhantom: true,
      mu: phantomMu,
      sigma: phantomSigma
    });
  }
  
  // Sort by turn order for proper rating calculation
  commanderEntries.sort((a, b) => a.turnOrder - b.turnOrder);
  
  // Get ratings for real commanders, use default for phantoms
  const commanderRatings: Record<string, Rating> = {};
  const commanderRecords: Record<string, any> = {};
  
  for (const entry of commanderEntries) {
    if (entry.isPhantom) {
      commanderRatings[entry.normalizedName] = rating({ mu: entry.mu, sigma: entry.sigma });
      commanderRecords[entry.normalizedName] = { wins: 0, losses: 0, draws: 0, displayName: entry.commander };
    } else {
      const deckData = await getOrCreateDeck(entry.normalizedName, entry.commander);
      commanderRatings[entry.normalizedName] = rating({ mu: deckData.mu, sigma: deckData.sigma });
      commanderRecords[entry.normalizedName] = {
        wins: deckData.wins || 0,
        losses: deckData.losses || 0,
        draws: deckData.draws || 0,
        displayName: deckData.displayName
      };
    }
  }
  
  // Calculate new ratings using OpenSkill
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = commanderEntries.map(entry => statusRank[entry.status]);
  
  const ordered = commanderEntries.map(entry => [commanderRatings[entry.normalizedName]]);
  const newMatrix = rate(ordered, { rank: ranks });
  
  // Apply 3-deck penalty if needed (based on real commanders only)
  const realCommanderCount = commanderEntries.filter(c => !c.isPhantom).length;
  const penalty = realCommanderCount === 3 ? 0.9 : 1.0;
  
  // Update only real commanders
  for (let i = 0; i < commanderEntries.length; i++) {
    const entry = commanderEntries[i];
    if (entry.isPhantom) continue; // Skip phantoms

    const oldR = commanderRatings[entry.normalizedName];
    const newR = newMatrix[i][0];

    // Apply penalty
    let finalRating: Rating = {
      mu: 25 + (newR.mu - 25) * penalty,
      sigma: newR.sigma
    };

    // Apply participation bonus (+1 Elo for playing ranked)
    finalRating = applyParticipationBonus(finalRating);

    const rec = commanderRecords[entry.normalizedName];
    if (entry.status === 'w') rec.wins++;
    else if (entry.status === 'l') rec.losses++;
    else if (entry.status === 'd') rec.draws++;

    // Update database
    await updateDeckRating(
      entry.normalizedName,
      rec.displayName,
      finalRating.mu,
      finalRating.sigma,
      rec.wins,
      rec.losses,
      rec.draws
    );

    // Log the commander rating change
    try {
      await logRatingChange({
        targetType: 'deck',
        targetId: entry.normalizedName,
        targetDisplayName: rec.displayName,
        changeType: 'game',
        oldMu: oldR.mu,
        oldSigma: oldR.sigma,
        oldElo: calculateElo(oldR.mu, oldR.sigma),
        newMu: finalRating.mu,
        newSigma: finalRating.sigma,
        newElo: calculateElo(finalRating.mu, finalRating.sigma),
        parameters: JSON.stringify({
          gameId: gameId,
          result: entry.status,
          turnOrder: entry.turnOrder,
          phantomOpponents: phantomCount,
          realOpponents: realCommanderCount - 1,
          hybridPlayerDeckGame: true,
          originalPlayer: entry.originalPlayer
        })
      });
    } catch (auditError) {
      console.error('Error logging commander rating change to audit trail:', auditError);
    }
    
    // Record deck match
    await recordDeckMatch(
      `${matchId}-deck-${entry.turnOrder}`,
      gameId,
      entry.normalizedName,
      rec.displayName,
      entry.status,
      new Date(),
      finalRating.mu,
      finalRating.sigma,
      entry.turnOrder
    );
  }
}

// Helper function to find available turn order for phantoms (improved logic)
function findAvailableTurnOrderForPhantoms(existingEntries: any[]): number {
  const usedTurnOrders = new Set(existingEntries.map(e => e.turnOrder));
  
  // Fill gaps in turn order first, then continue sequentially
  for (let i = 1; i <= 4; i++) {
    if (!usedTurnOrders.has(i)) {
      return i;
    }
  }
  
  // This shouldn't happen with max 4 players, but fallback
  return existingEntries.length + 1;
}

async function processDeckResults(
  decks: DeckEntry[],
  deckRatings: Record<string, Rating>,
  deckRecords: Record<string, any>,
  matchId: string,
  gameId: string,
  gameSequence: number,
  submittedByAdmin: boolean,
  submitterId: string,
  replyMsg: any
) {
  // Note: Timewalk tracking is per-player based on lastPlayed timestamp
  // Deck games don't affect player decay timers directly

  // Calculate new ratings using OpenSkill (handles duplicates automatically)
  const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
  const ranks = decks.map(deck => statusRank[deck.status]);
  
  const ordered = decks.map(deck => [deckRatings[deck.normalizedName]]);
  const newMatrix = rate(ordered, { rank: ranks });
  
  // Apply 3-deck penalty if needed
  const is3DeckGame = decks.length === 3;
  if (is3DeckGame) {
    for (let i = 0; i < newMatrix.length; i++) {
      const newRating = newMatrix[i][0];
      newMatrix[i][0] = {
        mu: 25 + (newRating.mu - 25) * 0.9, // 10% penalty for 3-deck games
        sigma: newRating.sigma
      };
    }
  }
  
  // Aggregate updates for duplicate decks
  const deckUpdates: Record<string, { 
    newRating: any, 
    winCount: number, 
    lossCount: number, 
    drawCount: number,
    instances: DeckEntry[]
  }> = {};
  
  // Process each deck instance
  for (let i = 0; i < decks.length; i++) {
    const deck = decks[i];
    const newRating = newMatrix[i][0];
    
    if (!deckUpdates[deck.normalizedName]) {
      deckUpdates[deck.normalizedName] = {
        newRating: newRating,
        winCount: 0,
        lossCount: 0,
        drawCount: 0,
        instances: []
      };
    }
    
    // Use the latest rating calculation for this deck
    deckUpdates[deck.normalizedName].newRating = newRating;
    deckUpdates[deck.normalizedName].instances.push(deck);
    
    // Count results for this deck
    if (deck.status === 'w') deckUpdates[deck.normalizedName].winCount++;
    else if (deck.status === 'l') deckUpdates[deck.normalizedName].lossCount++;
    else if (deck.status === 'd') deckUpdates[deck.normalizedName].drawCount++;
  }
  
  // Update deck records and ratings
  const results: string[] = [];

  // Track final deck ratings (with participation bonus) for snapshot
  const finalDeckRatings: Record<string, Rating> = {};

  for (const [normalizedName, update] of Object.entries(deckUpdates)) {
    const oldR = deckRatings[normalizedName];
    let newR = update.newRating;
    const rec = deckRecords[normalizedName];
    const displayName = update.instances[0].commander;

    // Calculate Elos for display
    const oldElo = calculateElo(oldR.mu, oldR.sigma);
    const preBonusElo = calculateElo(newR.mu, newR.sigma);
    const ratingChange = preBonusElo - oldElo;
    const changeSign = ratingChange >= 0 ? '+' : '';

    // Apply participation bonus (+1 Elo for playing ranked)
    newR = applyParticipationBonus(newR);

    // Calculate final Elo for display
    const finalElo = calculateElo(newR.mu, newR.sigma);

    // Track final rating for snapshot
    finalDeckRatings[normalizedName] = newR;

    // Update win/loss/draw counts with aggregated results
    rec.wins += update.winCount;
    rec.losses += update.lossCount;
    rec.draws += update.drawCount;

    // Update database
    await updateDeckRating(
      normalizedName,
      displayName,
      newR.mu,
      newR.sigma,
      rec.wins,
      rec.losses,
      rec.draws
    );

    // Log the deck rating change for audit trail
    try {
      await logRatingChange({
        targetType: 'deck',
        targetId: normalizedName,
        targetDisplayName: displayName,
        changeType: 'game',
        oldMu: oldR.mu,
        oldSigma: oldR.sigma,
        oldElo: calculateElo(oldR.mu, oldR.sigma),
        newMu: newR.mu,
        newSigma: newR.sigma,
        newElo: calculateElo(newR.mu, newR.sigma),
        parameters: JSON.stringify({
          gameId: gameId,
          duplicateCount: update.instances.length,
          results: update.instances.map(i => i.status),
          turnOrders: update.instances.map(i => i.turnOrder),
          opponents: decks.length - update.instances.length,
          is3DeckPenalty: decks.length === 3,
          deckOnlyMode: true
        })
      });
    } catch (auditError) {
      console.error('Error logging deck rating change to audit trail:', auditError);
    }
    
    // Record individual matches for each instance
    for (const instance of update.instances) {
      await recordDeckMatch(
        `${matchId}-${instance.turnOrder}`, // Unique match ID for each instance
        gameId,
        normalizedName,
        displayName,
        instance.status,
        new Date(),
        newR.mu,
        newR.sigma,
        instance.turnOrder
      );
    }

    const duplicateNote = update.instances.length > 1 ? ` (${update.instances.length} copies)` : '';
    const instanceResults = update.instances.map(i => `Turn ${i.turnOrder}: ${i.status.toUpperCase()}`).join(', ');

    results.push(
      `**${displayName}${duplicateNote}**\n` +
      `Instances: ${instanceResults}\n` +
      `Elo: ${oldElo} → ${preBonusElo} (${changeSign}${ratingChange}) + 1 (participation) = **${finalElo}**\n` +
      `Mu: ${oldR.mu.toFixed(2)} → ${newR.mu.toFixed(2)} | Sigma: ${oldR.sigma.toFixed(2)} → ${newR.sigma.toFixed(2)}\n` +
      `W/L/D: ${rec.wins}/${rec.losses}/${rec.draws}`
    );
  }

  // Update deck matches with sequence number
  await updateMatchesWithSequence(gameId, gameSequence, 'deck');

  // Build complete deck match data for snapshot (needed for proper undo/redo)
  const deckMatchDataForSnapshot: any[] = [];
  for (const normalizedName of Object.keys(deckUpdates)) {
    const update = deckUpdates[normalizedName];
    const displayName = update.instances[0].commander;
    for (const instance of update.instances) {
      deckMatchDataForSnapshot.push({
        id: `${matchId}-${instance.turnOrder}`,
        gameId: gameId,
        deckNormalizedName: normalizedName,
        deckDisplayName: displayName,
        status: instance.status,
        matchDate: new Date().toISOString(),
        mu: finalDeckRatings[normalizedName].mu,
        sigma: finalDeckRatings[normalizedName].sigma,
        turnOrder: instance.turnOrder,
        submittedByAdmin: submittedByAdmin,
        submittedBy: submitterId,
        assignedPlayer: null  // Deck games don't track assigned players
      });
    }
  }

  // Save deck match snapshot for undo/redo functionality
  await saveMatchSnapshot({
    matchId,
    gameId,
    gameSequence,
    gameType: 'deck',
    matchData: deckMatchDataForSnapshot,
    before: Object.keys(deckUpdates).map(normalizedName => {
      const rec = deckRecords[normalizedName];
      const update = deckUpdates[normalizedName];
      return {
        normalizedName,
        displayName: update.instances[0].commander,
        mu: deckRatings[normalizedName].mu,
        sigma: deckRatings[normalizedName].sigma,
        wins: rec.wins - update.winCount,
        losses: rec.losses - update.lossCount,
        draws: rec.draws - update.drawCount,
        turnOrder: update.instances[0].turnOrder
      };
    }),
    after: Object.keys(deckUpdates).map(normalizedName => {
      const rec = deckRecords[normalizedName];
      const update = deckUpdates[normalizedName];
      return {
        normalizedName,
        displayName: update.instances[0].commander,
        mu: finalDeckRatings[normalizedName].mu,
        sigma: finalDeckRatings[normalizedName].sigma,
        wins: rec.wins,
        losses: rec.losses,
        draws: rec.draws,
        turnOrder: update.instances[0].turnOrder
      };
    })
  });

  const resultEmbed = new EmbedBuilder()
    .setTitle('✅ Deck battle confirmed! Results are now final!')
    .setDescription(`🎯 **Game ID: ${gameId}**\n\n` + results.join('\n\n'))
    .setColor(0x4BB543);

  const chan = replyMsg.channel as TextChannel;
  await chan.send({ embeds: [resultEmbed] });
}