import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder,
  User
} from 'discord.js';
import { getOrCreatePlayer, getAllPlayers, getRestrictedPlayers, getPlayerTurnOrderStats } from '../db/player-utils.js';
import { getOrCreateDeck, getAllDecks, getDeckTurnOrderStats } from '../db/deck-utils.js';
import { calculateElo } from '../utils/elo-utils.js';
import { getDatabase } from '../db/init.js';
import { normalizeCommanderName } from '../utils/edhrec-utils.js';
import { playerExistsWithGames, deckExistsWithGames } from '../db/database-utils.js';

export const data = new SlashCommandBuilder()
  .setName('view')
  .setDescription('View league statistics, player stats, commander stats, or game details')
  .addStringOption(option =>
    option
      .setName('type')
      .setDescription('What to view')
      .setRequired(false)
      .addChoices(
        { name: 'League Stats (default)', value: 'league' },
        { name: 'Player', value: 'player' },
        { name: 'Commander', value: 'commander' },
        { name: 'Game', value: 'game' }
      )
  )
  .addUserOption(option =>
    option.setName('player')
      .setDescription('Player to view (for player type)')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('commander')
      .setDescription('Commander to view (for commander type)')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('gameid')
      .setDescription('Game ID to view (for game type)')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Defer immediately since all branches do database queries
  await interaction.deferReply();

  const targetUser = interaction.options.getUser('player');
  const commanderName = interaction.options.getString('commander');
  const gameId = interaction.options.getString('gameid');

  // Infer type from provided options, or use explicit type, or default to 'league'
  let type = interaction.options.getString('type');
  if (!type) {
    if (targetUser) {
      type = 'player';
    } else if (commanderName) {
      type = 'commander';
    } else if (gameId) {
      type = 'game';
    } else {
      type = 'league';
    }
  }

  // Route to appropriate function based on type
  if (type === 'league') {
    await showLeagueStats(interaction);
  } else if (type === 'player') {
    if (!targetUser) {
      await interaction.editReply({
        content: '❌ You must specify a player when using type:player.'
      });
      return;
    }

    if (!await playerExistsWithGames(targetUser.id)) {
      await interaction.editReply({
        content: `❌ ${targetUser.displayName || targetUser.username} has not participated in any games yet.`
      });
      return;
    }
    
    await showPlayerStats(interaction, targetUser);
  } else if (type === 'commander') {
    if (!commanderName) {
      await interaction.editReply({
        content: '❌ You must specify a commander when using type:commander.'
      });
      return;
    }

    const normalizedName = normalizeCommanderName(commanderName);
    if (!await deckExistsWithGames(normalizedName)) {
      await interaction.editReply({
        content: `❌ Commander "${commanderName}" has not been played in any games yet.`
      });
      return;
    }

    await showCommanderStats(interaction, commanderName);
  } else if (type === 'game') {
    if (!gameId) {
      await interaction.editReply({
        content: '❌ You must specify a gameid when using type:game.'
      });
      return;
    }

    await showGameDetails(interaction, gameId);
  }
}

async function showLeagueStats(interaction: ChatInputCommandInteraction) {
  const db = getDatabase();

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
    
    // Calculate players with games
    const playersWithGames = allPlayers.filter(p => {
      const totalGames = (p.wins || 0) + (p.losses || 0) + (p.draws || 0);
      return totalGames > 0;
    }).length;
    
    // Get total games
    const totalGamesResult = await db.get('SELECT COUNT(*) as count FROM games_master WHERE status = "confirmed" AND active = 1');
    const totalGames = totalGamesResult.count;
    
    // Calculate average games per active player
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
    
    // Get top performing player and deck (exclude restricted players)
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

    // Create embed
    const embed = new EmbedBuilder()
      .setTitle('📊 League Statistics')
      .setColor(0x00AE86)
      .setTimestamp();

    // Enhanced description
    const qualificationRate = totalPlayers > 0 ? Math.round((qualifiedPlayers.length / totalPlayers) * 100) : 0;
    const deckQualificationRate = totalDecks > 0 ? ((qualifiedDecks.length / totalDecks) * 100).toFixed(1) : '0.0';
    
    embed.setDescription(
      `**League Overview**\n` +
      `Average games per active player: **${avgGamesPerPlayer}**\n` +
      `Player qualification rate: **${qualificationRate}%** (${qualifiedPlayers.length}/${totalPlayers})\n` +
      `Deck qualification rate: **${deckQualificationRate}%** (${qualifiedDecks.length}/${totalDecks})\n` +
      `Players with deck assignments: **${playersWithDecksResult?.count || 0}**`
    );

    // Population stats
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

    // Top performers (excludes restricted players)
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

    // Turn order analysis (excludes restricted players)
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

async function showPlayerStats(interaction: ChatInputCommandInteraction, targetUser: User) {
  const userId = targetUser.id;
  const displayName = targetUser.displayName || targetUser.username;

  try {
    const player = await getOrCreatePlayer(userId);
    const elo = calculateElo(player.mu, player.sigma);
    const totalGames = player.wins + player.losses + player.draws;

    // Get rank among all players
    const allPlayers = await getAllPlayers();
    const rankedPlayers = allPlayers
      .map(p => ({ id: p.userId, elo: calculateElo(p.mu, p.sigma), totalGames: p.wins + p.losses + p.draws }))
      .filter(p => p.totalGames >= 5) // Only qualified players
      .sort((a, b) => b.elo - a.elo);

    const rank = rankedPlayers.findIndex(p => p.id === userId) + 1;
    const rankText = rank > 0 ? `#${rank}` : 'Unranked';
    const qualified = totalGames >= 5;

    // Get recent games
    const db = getDatabase();
    const recentGames = await db.all(`
      SELECT m.status, m.matchDate, m.turnOrder, m.assignedDeck, m.gameId
      FROM matches m
      JOIN games_master gm ON m.gameId = gm.gameId
      WHERE m.userId = ? AND gm.active = 1
      ORDER BY m.matchDate DESC 
      LIMIT 10
    `, userId);

    // Get turn order stats
    const turnOrderStats = await getPlayerTurnOrderStats(userId);

    // Get top performing decks
    const topDecks = await getTopPlayerDecks(userId);

    // Calculate win rate
    const winRate = totalGames > 0 ? ((player.wins / totalGames) * 100).toFixed(1) : '0.0';

    const embed = new EmbedBuilder()
      .setTitle(`📊 Player Statistics: ${displayName}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setColor(qualified ? 0x00AE86 : 0xFFAA00);

    // Basic stats
    embed.addFields({
      name: '🎯 Current Rating',
      value: `**Elo:** ${elo}\n**Rank:** ${rankText}\n**Mu:** ${player.mu.toFixed(2)}\n**Sigma:** ${player.sigma.toFixed(2)}`,
      inline: true
    });

    embed.addFields({
      name: '📈 Record',
      value: `**W/L/D:** ${player.wins}/${player.losses}/${player.draws}\n**Win Rate:** ${winRate}%\n**Games:** ${totalGames}`,
      inline: true
    });

    embed.addFields({
      name: '🏆 Status',
      value: qualified ? '✅ **Qualified**' : `⚠️ Need ${5 - totalGames} more games`,
      inline: true
    });

    // Top performing decks
    if (topDecks.length > 0) {
      const deckList = topDecks.slice(0, 5).map((deck, index) => {
        const deckWinRate = deck.totalGames > 0 ? ((deck.wins / deck.totalGames) * 100).toFixed(1) : '0.0';
        return `${index + 1}. **${deck.deckDisplayName}** - ${deckWinRate}% (${deck.wins}W/${deck.losses}L/${deck.draws}D)`;
      }).join('\n');

      embed.addFields({
        name: '⚔️ Top 5 Performing Decks',
        value: deckList,
        inline: false
      });
    }

    // Turn order performance
    if (turnOrderStats.length > 0) {
      const turnOrderDisplay = turnOrderStats
        .filter(stat => stat.totalGames > 0)
        .map(stat => {
          const winRate = ((stat.wins / stat.totalGames) * 100).toFixed(1);
          return `**Turn ${stat.turnOrder}:** ${winRate}% (${stat.wins}/${stat.totalGames})`;
        })
        .join('\n');

      if (turnOrderDisplay) {
        embed.addFields({
          name: '🔄 Turn Order Performance',
          value: turnOrderDisplay,
          inline: false
        });

        // Best/worst position analysis
        const statsWithWinRate = turnOrderStats
          .filter(stat => stat.totalGames > 0)
          .map(stat => ({ ...stat, winRate: stat.wins / stat.totalGames }));

        if (statsWithWinRate.length > 1) {
          const bestTurn = statsWithWinRate.reduce((best, current) => 
            current.winRate > best.winRate ? current : best
          );
          const worstTurn = statsWithWinRate.reduce((worst, current) => 
            current.winRate < worst.winRate ? current : worst
          );

          embed.addFields({
            name: '📈 Turn Order Analysis',
            value: `**Best Position:** Turn ${bestTurn.turnOrder} (${(bestTurn.winRate * 100).toFixed(1)}%)\n**Worst Position:** Turn ${worstTurn.turnOrder} (${(worstTurn.winRate * 100).toFixed(1)}%)`,
            inline: false
          });
        }
      }
    }

    // Recent activity
    if (recentGames.length > 0) {
      const recentDisplay = recentGames.slice(0, 5).map(game => {
        const status = game.status === 'w' ? '🟢 Win' : game.status === 'l' ? '🔴 Loss' : '🟡 Draw';
        const turnInfo = game.turnOrder ? ` (T${game.turnOrder})` : '';
        const deckInfo = game.assignedDeck ? ` with ${game.assignedDeck}` : '';
        const date = new Date(game.matchDate).toLocaleDateString();
        return `${status}${turnInfo}${deckInfo} - ${date}`;
      }).join('\n');

      embed.addFields({
        name: '🕒 Recent Games',
        value: recentDisplay,
        inline: false
      });
    }

    // Last played
    if (player.lastPlayed) {
      const lastPlayedDate = new Date(player.lastPlayed).toLocaleDateString();
      embed.setFooter({ text: `Last played: ${lastPlayedDate}` });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error fetching player stats:', error);
    await interaction.editReply({
      content: '❌ Error fetching player statistics.'
    });
  }
}

async function showCommanderStats(interaction: ChatInputCommandInteraction, commanderName: string) {
  const normalizedName = normalizeCommanderName(commanderName);

  try {
    const db = getDatabase();
    const deck = await db.get('SELECT * FROM decks WHERE normalizedName = ?', normalizedName);

    const elo = calculateElo(deck.mu, deck.sigma);
    const totalGames = deck.wins + deck.losses + deck.draws;

    // Get rank among all decks
    const allDecks = await getAllDecks();
    const rankedDecks = allDecks
      .map(d => ({ name: d.normalizedName, elo: calculateElo(d.mu, d.sigma), totalGames: d.wins + d.losses + d.draws }))
      .filter(d => d.totalGames >= 5)
      .sort((a, b) => b.elo - a.elo);

    const rank = rankedDecks.findIndex(d => d.name === normalizedName) + 1;
    const rankText = rank > 0 ? `#${rank}` : 'Unranked';
    const qualified = totalGames >= 5;

    // Get recent games
    const recentGames = await db.all(`
      SELECT dm.status, dm.matchDate, dm.turnOrder, dm.assignedPlayer, dm.gameId
      FROM deck_matches dm
      JOIN games_master gm ON dm.gameId = gm.gameId
      WHERE dm.deckNormalizedName = ? AND gm.active = 1
      ORDER BY dm.matchDate DESC 
      LIMIT 10
    `, normalizedName);

    // Get turn order stats
    const turnOrderStats = await getDeckTurnOrderStats(normalizedName);

    // Get players who have used this deck
    const playersUsing = await db.all(`
      SELECT dm.assignedPlayer, COUNT(*) as games, 
             SUM(CASE WHEN dm.status = 'w' THEN 1 ELSE 0 END) as wins
      FROM deck_matches dm
      JOIN games_master gm ON dm.gameId = gm.gameId
      WHERE dm.deckNormalizedName = ? AND dm.assignedPlayer IS NOT NULL AND gm.active = 1
      GROUP BY dm.assignedPlayer
      ORDER BY games DESC
      LIMIT 5
    `, normalizedName);

    // Calculate win rate
    const winRate = totalGames > 0 ? ((deck.wins / totalGames) * 100).toFixed(1) : '0.0';

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ Commander Statistics: ${deck.displayName}`)
      .setColor(qualified ? 0x00AE86 : 0xFFAA00);

    // Basic stats
    embed.addFields({
      name: '🎯 Current Rating',
      value: `**Elo:** ${elo}\n**Rank:** ${rankText}\n**Mu:** ${deck.mu.toFixed(2)}\n**Sigma:** ${deck.sigma.toFixed(2)}`,
      inline: true
    });

    embed.addFields({
      name: '📈 Record',
      value: `**W/L/D:** ${deck.wins}/${deck.losses}/${deck.draws}\n**Win Rate:** ${winRate}%\n**Games:** ${totalGames}`,
      inline: true
    });

    embed.addFields({
      name: '🏆 Status',
      value: qualified ? '✅ **Qualified**' : `⚠️ Need ${5 - totalGames} more games`,
      inline: true
    });

    // Turn order performance
    if (turnOrderStats.length > 0) {
      const turnOrderDisplay = turnOrderStats
        .filter(stat => stat.totalGames > 0)
        .map(stat => {
          const winRate = ((stat.wins / stat.totalGames) * 100).toFixed(1);
          return `**Turn ${stat.turnOrder}:** ${winRate}% (${stat.wins}/${stat.totalGames})`;
        })
        .join('\n');

      if (turnOrderDisplay) {
        embed.addFields({
          name: '🔄 Turn Order Performance',
          value: turnOrderDisplay,
          inline: false
        });

        // Best/worst position analysis
        const statsWithWinRate = turnOrderStats
          .filter(stat => stat.totalGames > 0)
          .map(stat => ({ ...stat, winRate: stat.wins / stat.totalGames }));

        if (statsWithWinRate.length > 1) {
          const bestTurn = statsWithWinRate.reduce((best, current) => 
            current.winRate > best.winRate ? current : best
          );
          const worstTurn = statsWithWinRate.reduce((worst, current) => 
            current.winRate < worst.winRate ? current : worst
          );

          embed.addFields({
            name: '📈 Turn Order Analysis',
            value: `**Best Position:** Turn ${bestTurn.turnOrder} (${(bestTurn.winRate * 100).toFixed(1)}%)\n**Worst Position:** Turn ${worstTurn.turnOrder} (${(worstTurn.winRate * 100).toFixed(1)}%)`,
            inline: false
          });
        }
      }
    }

    // Players using this deck
    if (playersUsing.length > 0) {
      const playersDisplay = playersUsing.map(player => {
        const playerWinRate = player.games > 0 ? ((player.wins / player.games) * 100).toFixed(1) : '0.0';
        return `<@${player.assignedPlayer}> - ${playerWinRate}% (${player.wins}W/${player.games}G)`;
      }).join('\n');

      embed.addFields({
        name: '👥 Top Players Using This Deck',
        value: playersDisplay,
        inline: false
      });
    }

    // Recent activity
    if (recentGames.length > 0) {
      const recentDisplay = recentGames.slice(0, 5).map(game => {
        const status = game.status === 'w' ? '🟢 Win' : game.status === 'l' ? '🔴 Loss' : '🟡 Draw';
        const turnInfo = game.turnOrder ? ` (T${game.turnOrder})` : '';
        const playerInfo = game.assignedPlayer ? ` by <@${game.assignedPlayer}>` : '';
        const date = new Date(game.matchDate).toLocaleDateString();
        return `${status}${turnInfo}${playerInfo} - ${date}`;
      }).join('\n');

      embed.addFields({
        name: '🕒 Recent Games',
        value: recentDisplay,
        inline: false
      });
    }

    // Creation date
    if (deck.createdAt) {
      const createdDate = new Date(deck.createdAt).toLocaleDateString();
      embed.setFooter({ text: `First used: ${createdDate}` });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error fetching commander stats:', error);
    await interaction.editReply({
      content: '❌ Error fetching commander statistics.'
    });
  }
}

async function showGameDetails(interaction: ChatInputCommandInteraction, gameId: string) {
  const db = getDatabase();
  
  try {
    // Get game info
    const gameInfo = await db.get('SELECT * FROM games_master WHERE gameId = ?', gameId);
    
    if (!gameInfo) {
      await interaction.editReply({
        content: `❌ Game "${gameId}" not found in database.`
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎮 Game Details: ${gameId}`)
      .setColor(gameInfo.active === 1 ? 0x00AE86 : 0xFF0000)
      .setTimestamp(new Date(gameInfo.createdAt));

    // Game header info
    let headerInfo = `**Game Type:** ${gameInfo.gameType === 'player' ? 'Player Game' : 'Deck-Only Game'}\n`;
    headerInfo += `**Status:** ${gameInfo.status.toUpperCase()}`;
    if (gameInfo.active === 0) {
      headerInfo += ` ⚠️ (INACTIVE)`;
    }
    headerInfo += `\n**Sequence:** ${gameInfo.gameSequence}\n`;
    headerInfo += `**Submitted By:** <@${gameInfo.submittedBy}>`;
    if (gameInfo.submittedByAdmin) {
      headerInfo += ` 👑 (Admin)`;
    }
    headerInfo += `\n**Created:** ${new Date(gameInfo.createdAt).toLocaleString()}`;

    embed.setDescription(headerInfo);

    if (gameInfo.gameType === 'player') {
      // Get all player matches for this game
      const matches = await db.all(`
        SELECT * FROM matches 
        WHERE gameId = ? 
        ORDER BY turnOrder ASC, matchDate ASC
      `, gameId);

      if (matches.length === 0) {
        embed.addFields({
          name: '❌ Error',
          value: 'No match data found for this game.',
          inline: false
        });
      } else {
        // Get player data for all participants
        for (const match of matches) {
          const player = await db.get('SELECT * FROM players WHERE userId = ?', match.userId);
          
          let fieldValue = '';
          
          // Result
          const result = match.status === 'w' ? '🏆 WIN' : match.status === 'd' ? '🤝 DRAW' : '💀 LOSS';
          fieldValue += `**Result:** ${result}\n`;
          
          // Turn order
          fieldValue += `**Turn Order:** ${match.turnOrder || 'Unknown'}\n`;
          
          // CRITICAL FIX: Show assigned commander
            if (match.assignedDeck) {
              const deckData = await db.get('SELECT displayName FROM decks WHERE normalizedName = ?', match.assignedDeck);
              const commanderDisplay = deckData?.displayName || match.assignedDeck;
              fieldValue += `**Commander:** ${commanderDisplay}\n`;
            }
          
          // Rating after game
          const eloAfter = calculateElo(match.mu, match.sigma);
          fieldValue += `**Rating After:** ${eloAfter} Elo\n`;
          fieldValue += `**Mu/Sigma:** ${match.mu.toFixed(2)} / ${match.sigma.toFixed(2)}\n`;
          
          // Player's current stats
          if (player) {
            const currentElo = calculateElo(player.mu, player.sigma);
            fieldValue += `**Current Rating:** ${currentElo} Elo\n`;
            fieldValue += `**Current Record:** ${player.wins}W/${player.losses}L/${player.draws}D`;
          }

          try {
            const user = await interaction.client.users.fetch(match.userId);
            embed.addFields({
              name: `👤 ${user.username}`,
              value: fieldValue,
              inline: true
            });
          } catch {
            embed.addFields({
              name: `👤 User ${match.userId}`,
              value: fieldValue,
              inline: true
            });
          }
        }
      }
    } else {
      // Deck game
      const deckMatches = await db.all(`
        SELECT * FROM deck_matches 
        WHERE gameId = ? 
        ORDER BY turnOrder ASC, matchDate ASC
      `, gameId);

      if (deckMatches.length === 0) {
        embed.addFields({
          name: '❌ Error',
          value: 'No deck match data found for this game.',
          inline: false
        });
      } else {
        // Get deck data for all participants
        for (const match of deckMatches) {
          const deck = await db.get('SELECT * FROM decks WHERE normalizedName = ?', match.deckNormalizedName);
          
          let fieldValue = '';
          
          // Result
          const result = match.status === 'w' ? '🏆 WIN' : match.status === 'd' ? '🤝 DRAW' : '💀 LOSS';
          fieldValue += `**Result:** ${result}\n`;
          
          // Turn order
          fieldValue += `**Turn Order:** ${match.turnOrder || 'Unknown'}\n`;
          
          // Assigned player
          if (match.assignedPlayer) {
            fieldValue += `**Piloted By:** <@${match.assignedPlayer}>\n`;
          }
          
          // Rating after game
          const eloAfter = calculateElo(match.mu, match.sigma);
          fieldValue += `**Rating After:** ${eloAfter} Elo\n`;
          fieldValue += `**Mu/Sigma:** ${match.mu.toFixed(2)} / ${match.sigma.toFixed(2)}\n`;
          
          // Deck's current stats
          if (deck) {
            const currentElo = calculateElo(deck.mu, deck.sigma);
            fieldValue += `**Current Rating:** ${currentElo} Elo\n`;
            fieldValue += `**Current Record:** ${deck.wins}W/${deck.losses}L/${deck.draws}D`;
          }

          embed.addFields({
            name: `⚔️ ${match.deckDisplayName}`,
            value: fieldValue,
            inline: true
          });
        }
      }
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error fetching game details:', error);
    await interaction.editReply({
      content: '❌ Error fetching game details.'
    });
  }
}

async function getTopPlayerDecks(userId: string) {
  const db = getDatabase();
  const decks = await db.all(`
    SELECT 
      m.assignedDeck as deckNormalizedName,
      COUNT(*) as totalGames,
      SUM(CASE WHEN m.status = 'w' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN m.status = 'l' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN m.status = 'd' THEN 1 ELSE 0 END) as draws
    FROM matches m
    JOIN games_master gm ON m.gameId = gm.gameId
    WHERE m.userId = ? AND m.assignedDeck IS NOT NULL AND gm.active = 1
    GROUP BY m.assignedDeck
    ORDER BY 
      (CAST(SUM(CASE WHEN m.status = 'w' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC,
      COUNT(*) DESC
  `, userId);

  // Get display names for decks
  for (const deck of decks) {
    const deckData = await db.get('SELECT displayName FROM decks WHERE normalizedName = ?', deck.deckNormalizedName);
    deck.deckDisplayName = deckData?.displayName || deck.deckNormalizedName;
  }

  return decks;
}