// Updated list.ts - Unified command that can display either players or decks

import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getAllPlayers, getRestrictedPlayers } from '../db/player-utils.js';
import { getAllDecks } from '../db/deck-utils.js';
import { calculateElo } from '../utils/elo-utils.js';

export const data = new SlashCommandBuilder()
  .setName('list')
  .setDescription('Show top players or commanders')
  .addIntegerOption(option =>
    option.setName('count')
      .setDescription('Number of entries to show (1-64)')
      .setMinValue(1)
      .setMaxValue(64)
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Show players or decks')
      .addChoices(
        { name: 'Players', value: 'players' },
        { name: 'Decks/Commanders', value: 'decks' }
      )
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const count = interaction.options.getInteger('count') ?? 10;
  const type = interaction.options.getString('type') ?? 'players';

  if (type === 'decks') {
    await showTopDecks(interaction, count);
  } else {
    await showTopPlayers(interaction, count);
  }
}

async function showTopPlayers(interaction: ChatInputCommandInteraction, count: number) {
  try {
    const allPlayers = await getAllPlayers();
    const restrictedPlayers = new Set(await getRestrictedPlayers());
    
    // Filter out restricted players and players with 0 games, but keep unqualified players
    const filteredPlayers = allPlayers.filter(player => {
      if (restrictedPlayers.has(player.userId)) return false;
      const totalGames = (player.wins || 0) + (player.losses || 0) + (player.draws || 0);
      return totalGames > 0; // Only exclude players with 0 games
    });

    if (filteredPlayers.length === 0) {
      await interaction.reply('No players have played any games yet.');
      return;
    }

    // Calculate Elo and sort
    const rankedPlayers = filteredPlayers
      .map(player => ({
        userId: player.userId,
        elo: calculateElo(player.mu, player.sigma),
        mu: player.mu,
        sigma: player.sigma,
        wins: player.wins || 0,
        losses: player.losses || 0,
        draws: player.draws || 0,
        totalGames: (player.wins || 0) + (player.losses || 0) + (player.draws || 0),
        qualified: ((player.wins || 0) + (player.losses || 0) + (player.draws || 0)) >= 5,
        lastPlayed: player.lastPlayed
      }))
      .sort((a, b) => b.elo - a.elo);

    // Handle ties and limit count
    const topPlayers = getTopEntriesWithTies(rankedPlayers, count, 'elo');

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top ${Math.min(count, topPlayers.length)} Players`)
      .setColor(0x00AE86)
      .setTimestamp();

    let description = '';
    let currentRank = 1;
    let previousElo = null;
    let playersAtCurrentRank = 0;

    for (let i = 0; i < topPlayers.length; i++) {
      const player = topPlayers[i];
      
      // Handle ranking with ties
      if (previousElo !== null && player.elo < previousElo) {
        currentRank += playersAtCurrentRank;
        playersAtCurrentRank = 1;
      } else {
        playersAtCurrentRank++;
      }
      
      
      // Add qualification status like the old list
      const qualificationStatus = player.qualified 
        ? '' 
        : ` *(needs ${5 - player.totalGames} more)*`;
      
      description += `RANK${currentRank}/POS${i + 1}. <@${player.userId}> - **${player.elo}** Elo${qualificationStatus}\n`;
      
      previousElo = player.elo;
    }

    embed.setDescription(description);
    
    const totalQualified = rankedPlayers.filter(p => p.qualified).length;
    const totalPlayers = rankedPlayers.length;
    const expandedNote = topPlayers.length > count 
      ? ` (expanded to ${topPlayers.length} due to ties)` 
      : '';
    
    embed.setFooter({ 
      text: `Showing ${topPlayers.length} players${expandedNote} • ${totalQualified} qualified of ${totalPlayers} total` 
    });

    await interaction.reply({ embeds: [embed] });

  } catch (error) {
    console.error('Error fetching player rankings:', error);
    await interaction.reply({ 
      content: 'An error occurred while fetching player rankings.', 
      ephemeral: true 
    });
  }
}

async function showTopDecks(interaction: ChatInputCommandInteraction, count: number) {
  try {
    const allDecks = await getAllDecks();
    
    // Filter out decks with 0 games (no restriction system for decks)
    const filteredDecks = allDecks.filter(deck => {
      const totalGames = (deck.wins || 0) + (deck.losses || 0) + (deck.draws || 0);
      return totalGames > 0; // Only exclude decks with 0 games
    });

    if (filteredDecks.length === 0) {
      await interaction.reply('No commanders have played any games yet.');
      return;
    }

    // Calculate Elo and sort
    const rankedDecks = filteredDecks
      .map(deck => ({
        normalizedName: deck.normalizedName,
        displayName: deck.displayName,
        elo: calculateElo(deck.mu, deck.sigma),
        mu: deck.mu,
        sigma: deck.sigma,
        wins: deck.wins || 0,
        losses: deck.losses || 0,
        draws: deck.draws || 0,
        totalGames: (deck.wins || 0) + (deck.losses || 0) + (deck.draws || 0),
        qualified: ((deck.wins || 0) + (deck.losses || 0) + (deck.draws || 0)) >= 5,
        createdAt: deck.createdAt
      }))
      .sort((a, b) => b.elo - a.elo);

    // Handle ties and limit count
    const topDecks = getTopEntriesWithTies(rankedDecks, count, 'elo');

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ Top ${Math.min(count, topDecks.length)} Commanders`)
      .setColor(0x9B59B6)
      .setTimestamp();

    let description = '';
    let currentRank = 1;
    let previousElo = null;
    let decksAtCurrentRank = 0;

    for (let i = 0; i < topDecks.length; i++) {
      const deck = topDecks[i];
      
      // Handle ranking with ties
      if (previousElo !== null && deck.elo < previousElo) {
        currentRank += decksAtCurrentRank;
        decksAtCurrentRank = 1;
      } else {
        decksAtCurrentRank++;
      }
      
      const statusIcon = getRankIcon(currentRank);
      
      // Add qualification status like the old list
      const qualificationStatus = deck.qualified 
        ? '' 
        : ` *(needs ${5 - deck.totalGames} more)*`;
      
      description += `RANK${currentRank}/POS${i + 1}. ${deck.displayName} - **${deck.elo}** Elo${qualificationStatus}\n`;
      
      previousElo = deck.elo;
    }

    embed.setDescription(description);
    
    const totalQualified = rankedDecks.filter(d => d.qualified).length;
    const totalDecks = rankedDecks.length;
    const expandedNote = topDecks.length > count 
      ? ` (expanded to ${topDecks.length} due to ties)` 
      : '';
    
    embed.setFooter({ 
      text: `Showing ${topDecks.length} commanders${expandedNote} • ${totalQualified} qualified of ${totalDecks} total` 
    });

    await interaction.reply({ embeds: [embed] });

  } catch (error) {
    console.error('Error fetching deck rankings:', error);
    await interaction.reply({ 
      content: 'An error occurred while fetching deck rankings.', 
      ephemeral: true 
    });
  }
}

function getTopEntriesWithTies<T extends { elo: number }>(
  entries: T[], 
  requestedCount: number, 
  field: keyof T
): T[] {
  if (entries.length <= requestedCount) {
    return entries;
  }

  const cutoffValue = entries[requestedCount - 1][field];
  let finalCount = requestedCount;

  // Include all entries tied with the last position
  while (finalCount < entries.length && entries[finalCount][field] === cutoffValue) {
    finalCount++;
  }

  return entries.slice(0, finalCount);
}

function getRankIcon(rank: number): string {
  switch (rank) {
    case 1: return '🥇';
    case 2: return '🥈';
    case 3: return '🥉';
    default: return '🎖️';
  }
}

function getPerformanceEmoji(winRate: number): string {
  if (winRate >= 60) return '🔥';
  if (winRate >= 50) return '⚡';
  if (winRate >= 40) return '💪';
  if (winRate >= 30) return '📈';
  return '🔄';
}

// Export function for use by other commands
export async function showTop64Players(interaction: ChatInputCommandInteraction) {
  await showTopPlayers(interaction, 64);
}

// Keep the old function for backward compatibility
export async function showTop50Players(interaction: ChatInputCommandInteraction) {
  await showTopPlayers(interaction, 50);
}