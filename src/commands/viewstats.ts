import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder,
  User
} from 'discord.js';
import { getOrCreatePlayer, getAllPlayers, getPlayerTurnOrderStats } from '../db/player-utils.js';
import { getOrCreateDeck, getAllDecks, getDeckTurnOrderStats } from '../db/deck-utils.js';
import { calculateElo } from '../utils/elo-utils.js';
import { getDatabase } from '../db/init.js';
import { normalizeCommanderName, validateCommander } from '../utils/edhrec-utils.js';
import { playerExistsWithGames, deckExistsWithGames } from '../db/database-utils.js';

export const data = new SlashCommandBuilder()
  .setName('viewstats')
  .setDescription('View detailed statistics for a player or commander')
  .addUserOption(option =>
    option.setName('player')
      .setDescription('Player to view stats for')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('commander')
      .setDescription('Commander to view stats for')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const targetUser = interaction.options.getUser('player');
  const commanderName = interaction.options.getString('commander');

  // Validate input
  if (!targetUser && !commanderName) {
    await interaction.reply({
      content: '❌ You must specify either a player or a commander.',
      ephemeral: true
    });
    return;
  }

  if (targetUser && commanderName) {
    await interaction.reply({
      content: '❌ Please specify either a player OR a commander, not both.',
      ephemeral: true
    });
    return;
  }

  if (targetUser) {
    // Check if player exists and has participated in games
    if (!await playerExistsWithGames(targetUser.id)) {
      await interaction.reply({
        content: `❌ ${targetUser.displayName || targetUser.username} has not participated in any games yet.`,
        ephemeral: true
      });
      return;
    }
    
    await showPlayerStats(interaction, targetUser);
  } else {
    const normalizedName = normalizeCommanderName(commanderName!);
    
    // Check if deck exists and has been played in games
    if (!await deckExistsWithGames(normalizedName)) {
      await interaction.reply({
        content: `❌ Commander "${commanderName}" has not been played in any games yet.`,
        ephemeral: true
      });
      return;
    }
    
    await showCommanderStats(interaction, commanderName!);
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

    await interaction.reply({ embeds: [embed] });

  } catch (error) {
    console.error('Error fetching player stats:', error);
    await interaction.reply({
      content: '❌ Error fetching player statistics.',
      ephemeral: true
    });
  }
}

async function showCommanderStats(interaction: ChatInputCommandInteraction, commanderName: string) {
  const normalizedName = normalizeCommanderName(commanderName);

  try {
    // Get deck data (we already know it exists from validation)
    const db = getDatabase();
    const deck = await db.get('SELECT * FROM decks WHERE normalizedName = ?', normalizedName);

    const elo = calculateElo(deck.mu, deck.sigma);
    const totalGames = deck.wins + deck.losses + deck.draws;

    // Get rank among all decks
    const allDecks = await getAllDecks();
    const rankedDecks = allDecks
      .map(d => ({ name: d.normalizedName, elo: calculateElo(d.mu, d.sigma), totalGames: d.wins + d.losses + d.draws }))
      .filter(d => d.totalGames >= 5) // Only qualified decks
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

    await interaction.reply({ embeds: [embed] });

  } catch (error) {
    console.error('Error fetching commander stats:', error);
    await interaction.reply({
      content: '❌ Error fetching commander statistics.',
      ephemeral: true
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
