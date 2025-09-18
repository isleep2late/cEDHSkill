// Enhanced leaguestats.ts - Fixed to exclude restricted players from top performers

import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getAllPlayers, getRestrictedPlayers } from '../db/player-utils.js';
import { getAllDecks } from '../db/deck-utils.js';
import { calculateElo } from '../utils/elo-utils.js';
import { getDatabase } from '../db/init.js';

export const data = new SlashCommandBuilder()
  .setName('leaguestats')
  .setDescription('View comprehensive league statistics and metrics');

export async function execute(interaction: ChatInputCommandInteraction) {
  const db = getDatabase(); 
  await interaction.deferReply();

  try {
    // Get basic counts
    const allPlayers = await getAllPlayers();
    const restrictedPlayers = await getRestrictedPlayers();
    const allDecks = await getAllDecks();
    
    // Create set of restricted player IDs for fast lookup
    const restrictedPlayerIds = new Set(restrictedPlayers);
    
    // Filter out restricted players for active calculations
    const activePlayers = allPlayers.filter(p => !restrictedPlayerIds.has(p.userId));
    
    const totalPlayers = allPlayers.length;
    const activePlayerCount = activePlayers.length;
    const totalDecks = allDecks.length;
    
    // Calculate qualified players and decks (excluding restricted players)
    const qualifiedPlayers = activePlayers.filter(p => (p.wins + p.losses + p.draws) >= 5);
    const qualifiedDecks = allDecks.filter(d => (d.wins + d.losses + d.draws) >= 5);
    
    // Calculate players with games (from old version) - including restricted for historical accuracy
    const playersWithGames = allPlayers.filter(p => {
      const totalGames = (p.wins || 0) + (p.losses || 0) + (p.draws || 0);
      return totalGames > 0;
    }).length;
    
    // Get total games
    const totalGamesResult = await db.get('SELECT COUNT(*) as count FROM games_master WHERE status = "confirmed" AND active = 1');
    const totalGames = totalGamesResult.count;
    
    // Calculate average games per active player (from old version)
    const avgGamesPerPlayer = playersWithGames > 0 
      ? (totalGames / playersWithGames).toFixed(1) 
      : '0.0';
    
    // Get player vs deck games
    const playerGamesResult = await db.get('SELECT COUNT(*) as count FROM games_master WHERE gameType = "player" AND status = "confirmed" AND active = 1');
const deckGamesResult = await db.get('SELECT COUNT(*) as count FROM games_master WHERE gameType = "deck" AND status = "confirmed" AND active = 1');
    
    // Get activity metrics
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const weeklyGamesResult = await db.get(`
  SELECT COUNT(*) as count 
  FROM games_master 
  WHERE createdAt >= ? AND status = "confirmed" AND active = 1
`, oneWeekAgo.toISOString());
    
    const monthlyGamesResult = await db.get(`
  SELECT COUNT(*) as count 
  FROM games_master 
  WHERE createdAt >= ? AND status = "confirmed" AND active = 1
`, oneMonthAgo.toISOString());
    
    // Get all active players (ever)
    const activePlayersResult = await db.get(`
      SELECT COUNT(DISTINCT m.userId) as count
      FROM matches m
      JOIN games_master g ON m.gameId = g.gameId
      WHERE g.status = "confirmed"
    `);

    // Get all unique commanders used (ever)
    const activeCommandersResult = await db.get(`
      SELECT COUNT(DISTINCT dm.deckNormalizedName) as count
      FROM deck_matches dm
      JOIN games_master g ON dm.gameId = g.gameId
      WHERE g.status = "confirmed"
    `);
    
    // Get players with assigned decks (excluding restricted players)
    const playersWithDecksResult = await db.get(`
      SELECT COUNT(DISTINCT userId) as count
      FROM (
        SELECT userId FROM player_deck_assignments
        WHERE userId NOT IN (SELECT userId FROM restricted)
        UNION
        SELECT userId FROM players 
        WHERE defaultDeck IS NOT NULL 
        AND userId NOT IN (SELECT userId FROM restricted)
      )
    `);
    
    // Get top performing player and deck (FIXED: exclude restricted players)
    const topPlayer = qualifiedPlayers.length > 0 
      ? qualifiedPlayers.reduce((top, current) => 
          calculateElo(current.mu, current.sigma) > calculateElo(top.mu, top.sigma) ? current : top
        )
      : null;
    
    const topDeck = qualifiedDecks.length > 0
      ? qualifiedDecks.reduce((top, current) =>
          calculateElo(current.mu, current.sigma) > calculateElo(top.mu, top.sigma) ? current : top
        )
      : null;
    
    // Calculate average Elo (excluding restricted players)
    const avgPlayerElo = qualifiedPlayers.length > 0
      ? Math.round(qualifiedPlayers.reduce((sum, p) => sum + calculateElo(p.mu, p.sigma), 0) / qualifiedPlayers.length)
      : 0;
    
    const avgDeckElo = qualifiedDecks.length > 0
      ? Math.round(qualifiedDecks.reduce((sum, d) => sum + calculateElo(d.mu, d.sigma), 0) / qualifiedDecks.length)
      : 0;
    
    // Get turn order statistics (excluding restricted players)
    const turnOrderStats = await db.all(`
      SELECT turnOrder, 
             COUNT(*) as totalGames,
             SUM(CASE WHEN status = 'w' THEN 1 ELSE 0 END) as wins
      FROM matches
      WHERE turnOrder IS NOT NULL
      AND userId NOT IN (SELECT userId FROM restricted)
      GROUP BY turnOrder
      ORDER BY turnOrder
    `);
    
    // Calculate win rates by turn order
    const turnOrderDisplay = turnOrderStats.map(stat => {
      const winRate = stat.totalGames > 0 ? ((stat.wins / stat.totalGames) * 100).toFixed(1) : '0.0';
      return `Turn ${stat.turnOrder}: ${winRate}% (${stat.wins}/${stat.totalGames})`;
    }).join('\n');
    
    // Get most played commanders
    const topCommandersResult = await db.all(`
      SELECT deckDisplayName, COUNT(*) as games
      FROM deck_matches dm
      JOIN games_master g ON dm.gameId = g.gameId
      WHERE g.status = "confirmed"
      GROUP BY deckNormalizedName
      ORDER BY games DESC
      LIMIT 5
    `);
    
    const topCommandersDisplay = topCommandersResult.map((cmd, index) => 
      `${index + 1}. **${cmd.deckDisplayName}** (${cmd.games} games)`
    ).join('\n');

    // Create embed with enhanced description from old version
    const embed = new EmbedBuilder()
      .setTitle('📊 League Statistics')
      .setColor(0x00AE86)
      .setTimestamp();

    // Enhanced description combining features from both versions
    const qualificationRate = totalPlayers > 0 ? Math.round((qualifiedPlayers.length / totalPlayers) * 100) : 0;
    const deckQualificationRate = totalDecks > 0 ? ((qualifiedDecks.length / totalDecks) * 100).toFixed(1) : '0.0';
    
    embed.setDescription(
      `**League Overview**\n` +
      `Average games per active player: **${avgGamesPerPlayer}**\n` +
      `Player qualification rate: **${qualificationRate}%** (${qualifiedPlayers.length}/${totalPlayers})\n` +
      `Deck qualification rate: **${deckQualificationRate}%** (${qualifiedDecks.length}/${totalDecks})\n` +
      `Players with deck assignments: **${playersWithDecksResult?.count || 0}**`
    );

    // Population stats (enhanced from old version)
    embed.addFields({
      name: '👥 Player Population',
      value: 
        `**Total Players:** ${totalPlayers}\n` +
        `**Active Players:** ${activePlayerCount}\n` +
        `**Restricted Players:** ${restrictedPlayers.length}\n` +
        `**Players with Games:** ${playersWithGames}\n` +
        `**Qualified Players:** ${qualifiedPlayers.length} (≥5 games)`,
      inline: true
    });

    // Commander/Deck stats
    embed.addFields({
      name: '⚔️ Commander Population',
      value: 
        `**Total Commanders:** ${totalDecks}\n` +
        `**Qualified Commanders:** ${qualifiedDecks.length} (≥5 games)\n` +
        `**Different Commanders Used:** ${activeCommandersResult.count}\n` +
        `**Players with Assignments:** ${playersWithDecksResult?.count || 0}`,
      inline: true
    });

    // Game activity
    embed.addFields({
      name: '🎮 Game Activity',
      value: 
        `**Total Games:** ${totalGames}\n` +
        `**Player Games:** ${playerGamesResult.count}\n` +
        `**Deck Games:** ${deckGamesResult.count}\n` +
        `**Weekly Games:** ${weeklyGamesResult.count}\n` +
        `**Monthly Games:** ${monthlyGamesResult.count}`,
      inline: true
    });

    // Performance metrics
    embed.addFields({
      name: '📈 Performance Metrics',
      value:
        `**Avg Player Elo:** ${avgPlayerElo}\n` +
        `**Avg Commander Elo:** ${avgDeckElo}\n` +
        `**Avg Games/Player:** ${avgGamesPerPlayer}\n` +
        `**Active Player Pool:** ${activePlayersResult.count}`,
      inline: true
    });

    // Top performers (NOW EXCLUDES RESTRICTED PLAYERS)
    if (topPlayer || topDeck) {
      let topPerformersText = '';
      if (topPlayer) {
        const topPlayerElo = calculateElo(topPlayer.mu, topPlayer.sigma);
        topPerformersText += `**Top Player:** <@${topPlayer.userId}> (${topPlayerElo} Elo)\n`;
      }
      if (topDeck) {
        const topDeckElo = calculateElo(topDeck.mu, topDeck.sigma);
        topPerformersText += `**Top Commander:** ${topDeck.displayName} (${topDeckElo} Elo)`;
      }
      
      embed.addFields({
        name: '🏆 Top Performers',
        value: topPerformersText,
        inline: false
      });
    }

    // Turn order analysis (now excludes restricted players)
    if (turnOrderDisplay) {
      embed.addFields({
        name: '🔄 Turn Order Win Rates',
        value: turnOrderDisplay,
        inline: false
      });
    }

    // Most played commanders
    if (topCommandersDisplay) {
      embed.addFields({
        name: '⚔️ Most Played Commanders',
        value: topCommandersDisplay,
        inline: false
      });
    }

    // System info
    const systemInfo = 
      `**Database:** ${totalGames} confirmed games tracked\n` +
      `**Deck Assignment System:** Active\n` +
      `**Turn Order Tracking:** ${turnOrderStats.length > 0 ? 'Active' : 'Limited Data'}\n` +
      `**Qualification Requirement:** 5 games minimum\n` +
      `**Restricted Players:** ${restrictedPlayers.length} excluded from rankings`;

    embed.addFields({
      name: '⚙️ System Information',
      value: systemInfo,
      inline: false
    });

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error generating league stats:', error);
    await interaction.editReply({
      content: '❌ An error occurred while generating league statistics.'
    });
  }
}