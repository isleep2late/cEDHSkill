// Enhanced predict.ts with EDHREC validation and all advanced features

import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getOrCreatePlayer, getPlayerTurnOrderStats, getAllPlayerTurnOrderStats } from '../db/player-utils.js';
import { getOrCreateDeck, getDeckTurnOrderStats } from '../db/deck-utils.js';
import { calculateElo } from '../utils/elo-utils.js';
import { normalizeCommanderName, validateCommander } from '../utils/edhrec-utils.js';
import { logger } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('predict')
  .setDescription('Predict game outcomes or view turn order statistics')
  .addStringOption(option =>
    option.setName('participants')
      .setDescription('1-4 participants: "@user,commander,phantom" - missing slots filled with phantoms')
      .setRequired(false)
  );

interface ParsedEntry {
  type: 'player' | 'deck' | 'player_deck';
  playerId?: string;
  deckName?: string;
  displayName: string;
  turnOrder: number;
}

interface ParticipantWithStats {
  type: 'player' | 'deck' | 'player_deck';
  playerId?: string;
  deckName?: string;
  displayName: string;
  turnOrder: number;
  elo: number;
  turnOrderWinRate: number;
  turnOrderGames: number;
  totalGames: number;
  overallWinRate: number;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const participantsInput = interaction.options.getString('participants');

  if (!participantsInput || participantsInput.trim() === '') {
    // Show general turn order statistics when no input provided
    await showTurnOrderStatistics(interaction);
    return;
  }

  await interaction.deferReply();

  try {
    // Parse input
    const entries = await parseInput(participantsInput);
    
    if (entries.length === 0) {
      await interaction.editReply({
        content: '❌ No valid participants found in your input. Use format: "@user,commander-name,phantom" or combinations thereof.'
      });
      return;
    }

    // Support 1-4 participants, pad with phantoms as needed
    if (entries.length > 4) {
      await interaction.editReply({
        content: '❌ Maximum 4 participants allowed for predictions.'
      });
      return;
    }

    // Validate all commander names
    const commanderNames = entries
      .filter(e => e.deckName)
      .map(e => e.deckName!);
    
    if (commanderNames.length > 0) {
      for (const commanderName of commanderNames) {
        try {
          if (!await validateCommander(commanderName)) {
            await interaction.editReply({
              content: `❌ "${commanderName}" is not a valid commander name according to EDHREC.`
            });
            return;
          }
        } catch (error) {
          logger.error('Error validating commander:', error);
          await interaction.editReply({
            content: `❌ Unable to validate commander "${commanderName}". Please check the name and try again.`
          });
          return;
        }
      }
    }

    // Pad with phantom players if less than 4 participants
    const paddedEntries = padEntriesTo4Players(entries);

    // Generate predictions
    await generatePredictions(interaction, paddedEntries);

  } catch (error) {
    logger.error('Error in predict command:', error);
    await interaction.editReply({
      content: '❌ An error occurred while generating predictions.'
    });
  }
}

async function parseInput(input: string): Promise<ParsedEntry[]> {
  const entries = input.split(',').map(s => s.trim()).filter(s => s.length > 0);
  const parsedEntries: ParsedEntry[] = [];
  
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const turnOrder = i + 1;
    
    // Check for explicit phantom player
    if (entry.toLowerCase() === 'phantom') {
      parsedEntries.push({
        type: 'player',
        displayName: `Phantom Player ${turnOrder}`,
        turnOrder
      });
      continue;
    }
    
    // Check for player mention pattern
    const playerMatch = entry.match(/<@!?(\d+)>/);
    
    if (playerMatch) {
      // Extract player ID and check for associated commander
      const playerId = playerMatch[1];
      const parts = entry.split(/\s+/).filter(s => s.length > 0);
      
      // Look for commander name (anything that's not a player mention)
      const deckParts = parts.filter(part => !part.match(/<@!?(\d+)>/));
      const deckName = deckParts.length > 0 ? deckParts.join(' ') : undefined;
      
      if (deckName) {
        parsedEntries.push({
          type: 'player_deck',
          playerId,
          deckName: normalizeCommanderName(deckName),
          displayName: `<@${playerId}> + ${deckName}`,
          turnOrder
        });
      } else {
        parsedEntries.push({
          type: 'player',
          playerId,
          displayName: `<@${playerId}>`,
          turnOrder
        });
      }
    } else {
      // No player mention found - assume it's just a commander name
      const normalizedName = normalizeCommanderName(entry);
      parsedEntries.push({
        type: 'deck',
        deckName: normalizedName,
        displayName: entry,
        turnOrder
      });
    }
  }
  
  return parsedEntries;
}

function padEntriesTo4Players(entries: ParsedEntry[]): ParsedEntry[] {
  const paddedEntries = [...entries];
  
  // Add phantom players with 1000 Elo for remaining slots
  for (let i = entries.length; i < 4; i++) {
    paddedEntries.push({
      type: 'player',
      displayName: `Phantom Player ${i + 1}`,
      turnOrder: i + 1
    });
  }
  
  return paddedEntries;
}

async function showTurnOrderStatistics(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const turnOrderStats = await getAllPlayerTurnOrderStats();

    if (turnOrderStats.length === 0) {
      await interaction.editReply({
        content: 'No turn order data available yet. Play some games with turn order tracking to see statistics!'
      });
      return;
    }

    // Group by turn order and calculate win rates
    const turnData = new Map<number, { wins: number, total: number }>();
    
    for (const stat of turnOrderStats) {
      const existing = turnData.get(stat.turnOrder) || { wins: 0, total: 0 };
      turnData.set(stat.turnOrder, {
        wins: existing.wins + stat.wins,
        total: existing.total + stat.totalGames
      });
    }

    // Convert to array and calculate percentages
    const results = Array.from(turnData.entries())
      .map(([turnOrder, data]) => ({
        turnOrder,
        winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
        totalGames: data.total,
        wins: data.wins
      }))
      .sort((a, b) => a.turnOrder - b.turnOrder);

    if (results.length === 0) {
      await interaction.editReply({
        content: 'No turn order data available yet.'
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 League Turn Order Statistics')
      .setColor(0x3498DB);

    const description = results.map(r => {
      const winRateStr = r.winRate.toFixed(1);
      const turnEmoji = ['🥇', '🥈', '🥉', '4️⃣'][r.turnOrder - 1] || '❓';
      return `${turnEmoji} **Turn ${r.turnOrder}**: ${winRateStr}% (${r.wins}/${r.totalGames} games)`;
    }).join('\n');

    const totalGames = results.reduce((sum, r) => sum + r.totalGames, 0);
    const avgWinRate = results.reduce((sum, r) => sum + r.winRate, 0) / results.length;

    // Find best and worst turn orders
    const validResults = results.filter(r => r.totalGames >= 10); // Minimum games for meaningful comparison
    if (validResults.length >= 2) {
      const sortedByWinRate = [...validResults].sort((a, b) => b.winRate - a.winRate);
      const best = sortedByWinRate[0];
      const worst = sortedByWinRate[sortedByWinRate.length - 1];
      
      embed.addFields({
        name: '📈 Analysis',
        value: `**Best Position:** Turn ${best.turnOrder} (${best.winRate.toFixed(1)}%)\n` +
               `**Worst Position:** Turn ${worst.turnOrder} (${worst.winRate.toFixed(1)}%)\n` +
               `**Average:** ${avgWinRate.toFixed(1)}%`,
        inline: false
      });
    }

    embed.setDescription(description);
    embed.setFooter({
      text: `Based on ${totalGames} total games • Use /predict with players/commanders for game predictions`
    });

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    logger.error('Error showing turn order statistics:', error);
    await interaction.editReply({
      content: '❌ Error retrieving turn order statistics.'
    });
  }
}

// Get league-wide turn order win rates for baseline calculations
async function getLeagueTurnOrderBaseline(): Promise<Record<number, number>> {
  const turnOrderStats = await getAllPlayerTurnOrderStats();
  
  // Group by turn order and calculate win rates
  const turnData = new Map<number, { wins: number, total: number }>();
  
  for (const stat of turnOrderStats) {
    const existing = turnData.get(stat.turnOrder) || { wins: 0, total: 0 };
    turnData.set(stat.turnOrder, {
      wins: existing.wins + stat.wins,
      total: existing.total + stat.totalGames
    });
  }

  // Convert to baseline win rates
  const baseline: Record<number, number> = {};
  for (const [turnOrder, data] of turnData.entries()) {
    baseline[turnOrder] = data.total > 0 ? data.wins / data.total : 0.25; // Default 25% if no data
  }
  
  // Ensure we have defaults for all turn orders
  for (let i = 1; i <= 4; i++) {
    if (!(i in baseline)) {
      baseline[i] = 0.25;
    }
  }
  
  return baseline;
}

async function generatePredictions(interaction: ChatInputCommandInteraction, entries: ParsedEntry[]) {
  // Get league-wide turn order baseline
  const leagueBaseline = await getLeagueTurnOrderBaseline();

  // Fetch stats for each entry
  const withStats: ParticipantWithStats[] = await Promise.all(
    entries.map(async entry => {
      let playerElo = 1000, playerTurnRate = 0, playerTurnGames = 0, playerTotalGames = 0, playerOverallWinRate = 0;
      let deckElo = 1000, deckTurnRate = 0, deckTurnGames = 0, deckTotalGames = 0, deckOverallWinRate = 0;
      let playerDisplayName = '';
      let deckDisplayName = '';

      // Handle phantom players
      if (entry.displayName.startsWith('Phantom Player')) {
        return {
          type: entry.type,
          displayName: entry.displayName,
          turnOrder: entry.turnOrder,
          elo: 1000,
          turnOrderWinRate: leagueBaseline[entry.turnOrder] || 0.25,
          turnOrderGames: 0,
          totalGames: 1, // Fake 1 game to avoid "no data" issues
          overallWinRate: 0.25
        } as ParticipantWithStats;
      }

      // Get player stats if applicable
      if (entry.playerId) {
        const playerData = await getOrCreatePlayer(entry.playerId);
        playerElo = calculateElo(playerData.mu, playerData.sigma);
        
        const playerTurnStats = await getPlayerTurnOrderStats(entry.playerId);
        const playerTurnStat = playerTurnStats.find(s => s.turnOrder === entry.turnOrder);
        
        const playerTotal = playerData.wins + playerData.losses + playerData.draws;
        playerOverallWinRate = playerTotal > 0 ? playerData.wins / playerTotal : 0;
        
        if (playerTurnStat && playerTurnStat.totalGames > 0) {
          playerTurnRate = playerTurnStat.wins / playerTurnStat.totalGames;
          playerTurnGames = playerTurnStat.totalGames;
        } else {
          // Fallback to overall win rate if no turn-specific data
          playerTurnRate = playerOverallWinRate;
        }
        
        playerTotalGames = playerTotal;
        playerDisplayName = `<@${entry.playerId}>`;
      }

      // Get deck stats if applicable
      if (entry.deckName) {
        const deckData = await getOrCreateDeck(entry.deckName, entry.displayName);
        deckElo = calculateElo(deckData.mu, deckData.sigma);
        
        const deckTurnStats = await getDeckTurnOrderStats(entry.deckName);
        const deckTurnStat = deckTurnStats.find(s => s.turnOrder === entry.turnOrder);
        
        const deckTotal = deckData.wins + deckData.losses + deckData.draws;
        deckOverallWinRate = deckTotal > 0 ? deckData.wins / deckTotal : 0;
        
        if (deckTurnStat && deckTurnStat.totalGames > 0) {
          deckTurnRate = deckTurnStat.wins / deckTurnStat.totalGames;
          deckTurnGames = deckTurnStat.totalGames;
        } else {
          // Fallback to overall win rate if no turn-specific data
          deckTurnRate = deckOverallWinRate;
        }
        
        deckTotalGames = deckTotal;
        deckDisplayName = deckData.displayName;
      }

      // Calculate combined stats based on entry type
      let combinedElo: number;
      let combinedTurnRate: number;
      let combinedTurnGames: number;
      let combinedTotalGames: number;
      let combinedOverallWinRate: number;
      let finalDisplayName: string;

      switch (entry.type) {
        case 'player':
          combinedElo = playerElo;
          combinedTurnRate = playerTurnRate;
          combinedTurnGames = playerTurnGames;
          combinedTotalGames = playerTotalGames;
          combinedOverallWinRate = playerOverallWinRate;
          finalDisplayName = playerDisplayName || entry.displayName;
          break;
        
        case 'deck':
          combinedElo = deckElo;
          combinedTurnRate = deckTurnRate;
          combinedTurnGames = deckTurnGames;
          combinedTotalGames = deckTotalGames;
          combinedOverallWinRate = deckOverallWinRate;
          finalDisplayName = deckDisplayName || entry.displayName;
          break;
        
        case 'player_deck':
          // Average the Elos and turn rates for player+deck combinations
          combinedElo = (playerElo + deckElo) / 2;
          combinedTurnRate = (playerTurnRate + deckTurnRate) / 2;
          combinedTurnGames = Math.min(playerTurnGames, deckTurnGames);
          combinedTotalGames = Math.min(playerTotalGames, deckTotalGames);
          combinedOverallWinRate = (playerOverallWinRate + deckOverallWinRate) / 2;
          finalDisplayName = `${playerDisplayName} + ${deckDisplayName}`;
          break;
      }

      return {
        type: entry.type,
        playerId: entry.playerId,
        deckName: entry.deckName,
        displayName: finalDisplayName,
        turnOrder: entry.turnOrder,
        elo: combinedElo,
        turnOrderWinRate: combinedTurnRate,
        turnOrderGames: combinedTurnGames,
        totalGames: combinedTotalGames,
        overallWinRate: combinedOverallWinRate
      } as ParticipantWithStats;
    })
  );

  // Check if any real entries have no games played
  const realEntries = withStats.filter(e => !e.displayName.startsWith('Phantom Player'));
  const unplayedEntries = realEntries.filter(e => e.totalGames === 0);
  
  if (unplayedEntries.length > 0) {
    const unplayedNames = unplayedEntries.map(e => e.displayName).join(', ');
    await interaction.editReply({
      content: `⚠️ The following entries have no game data: ${unplayedNames}\nPredictions require at least some historical game data for accurate results.`
    });
    return;
  }

  // Generate three prediction models
  const eloResults = calculateEloPredictions(withStats);
  const enhancedTurnResults = calculateEnhancedTurnOrderPredictions(withStats, leagueBaseline);
  const hybridResults = calculateHybridPredictions(withStats, leagueBaseline);

  // Create the embed
  const embed = new EmbedBuilder()
    .setTitle('🎯 Win Probability Prediction')
    .setColor(0x9B59B6);

  let description = '**Pure Elo Prediction (Skill/Strength Only):**\n' + 
                    eloResults.map(r => `**${r.name}** (Turn ${r.turnOrder}): ${r.pct}%`).join('\n');

  description += '\n\n**Enhanced Turn Order Prediction:**\n' + 
                 enhancedTurnResults.map(r => {
                   const dataNote = r.turnOrderGames > 0 
                     ? ` (${(r.personalWeight * 100).toFixed(0)}% personal)`
                     : ` (league avg)`;
                   return `**${r.name}** (Turn ${r.turnOrder}): ${r.pct}%${dataNote}`;
                 }).join('\n');
  
  description += '\n\n**Hybrid Prediction (60% Skill + 40% Enhanced Turn Order):**\n' + 
                 hybridResults.map(r => `**${r.name}** (Turn ${r.turnOrder}): ${r.pct}%`).join('\n');
  
  description += '\n\n*Enhanced turn order blends personal turn performance with league averages. Hybrid combines skill with positional advantage.*';

  // Add note about data availability
  const totalGamesPlayed = realEntries.reduce((sum, e) => sum + e.totalGames, 0);
  const avgGamesPerEntry = realEntries.length > 0 ? (totalGamesPlayed / realEntries.length).toFixed(1) : '0';
  
  embed.setDescription(description);
  embed.setFooter({
    text: `Based on ${totalGamesPlayed} total games (avg ${avgGamesPerEntry} per real entry)`
  });

  await interaction.editReply({ embeds: [embed] });
}

function calculateEloPredictions(participants: ParticipantWithStats[]): Array<{name: string, turnOrder: number, pct: number}> {
  // Use Bradley-Terry model with exponential scaling for proper skill-based win probabilities
  // This converts Elo ratings to win probabilities using the same math as chess/OpenSkill
  
  const eloStrengths = participants.map(p => Math.pow(10, p.elo / 400));
  const totalStrength = eloStrengths.reduce((sum, strength) => sum + strength, 0);
  
  return participants
    .map((p, index) => ({ 
      name: p.displayName, 
      turnOrder: p.turnOrder,
      pct: Math.round((eloStrengths[index] / totalStrength) * 100) 
    }))
    .sort((a, b) => b.pct - a.pct);
}

function calculateEnhancedTurnOrderPredictions(participants: ParticipantWithStats[], leagueBaseline: Record<number, number>): Array<{name: string, turnOrder: number, pct: number, personalWeight: number, turnOrderGames: number}> {
  const enhancedTurnResults = participants.map(p => {
    const leagueWinRate = leagueBaseline[p.turnOrder] || 0.25;
    const personalTurnRate = p.turnOrderWinRate;
    
    // Weight personal vs league data based on sample size
    // More personal games = more weight to personal rate
    const personalWeight = Math.min(p.turnOrderGames / 10, 0.8); // Max 80% weight to personal data
    const leagueWeight = 1 - personalWeight;
    
    const blendedTurnRate = (personalTurnRate * personalWeight) + (leagueWinRate * leagueWeight);
    
    return {
      name: p.displayName,
      turnOrder: p.turnOrder,
      blendedRate: blendedTurnRate,
      personalWeight: personalWeight,
      turnOrderGames: p.turnOrderGames
    };
  });

  // Calculate percentages
  const totalBlendedRate = enhancedTurnResults.reduce((sum, e) => sum + e.blendedRate, 0);
  
  return enhancedTurnResults
    .map(e => ({
      name: e.name,
      turnOrder: e.turnOrder,
      pct: totalBlendedRate > 0 ? Math.round((e.blendedRate / totalBlendedRate) * 100) : 25,
      personalWeight: e.personalWeight,
      turnOrderGames: e.turnOrderGames
    }))
    .sort((a, b) => b.pct - a.pct);
}

function calculateHybridPredictions(participants: ParticipantWithStats[], leagueBaseline: Record<number, number>): Array<{name: string, turnOrder: number, pct: number}> {
  const hybridResults = participants.map(p => {
    // Calculate proper Elo-based strength using Bradley-Terry model
    const eloStrengths = participants.map(entry => Math.pow(10, entry.elo / 400));
    const totalEloStrength = eloStrengths.reduce((sum, strength) => sum + strength, 0);
    const eloWinProbability = Math.pow(10, p.elo / 400) / totalEloStrength;
    
    // Calculate enhanced turn rate (same logic as enhanced turn order model)
    const leagueWinRate = leagueBaseline[p.turnOrder] || 0.25;
    const personalWeight = Math.min(p.turnOrderGames / 10, 0.8);
    const blendedTurnRate = (p.turnOrderWinRate * personalWeight) + (leagueWinRate * (1 - personalWeight));
    
    // Weighted combination: 60% skill/strength, 40% positional advantage
    const hybridScore = (eloWinProbability * 0.6) + (blendedTurnRate * 0.4);
    
    return {
      name: p.displayName,
      turnOrder: p.turnOrder,
      hybridScore
    };
  });

  // Calculate percentages
  const totalHybridScore = hybridResults.reduce((sum, e) => sum + e.hybridScore, 0);
  
  return hybridResults
    .map(e => ({
      name: e.name,
      turnOrder: e.turnOrder,
      pct: totalHybridScore > 0 ? Math.round((e.hybridScore / totalHybridScore) * 100) : 25
    }))
    .sort((a, b) => b.pct - a.pct);
}