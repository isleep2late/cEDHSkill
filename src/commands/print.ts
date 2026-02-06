import { SlashCommandBuilder, ChatInputCommandInteraction, AttachmentBuilder } from 'discord.js';
import { config } from '../config.js';
import { calculateElo } from '../utils/elo-utils.js';
import { getRatingChangesForTarget, getAllRatingChanges } from '../utils/rating-audit-utils.js';

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('print')
  .setDescription('Admin/Mod: Export league history to a text file with various filtering options')
  .addStringOption(option =>
    option
      .setName('target')
      .setDescription('Filter options: blank, @user, commander-name, "decay", "set", "undo", "admin", "restricted"')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Defer immediately to prevent interaction timeout
  await interaction.deferReply({ ephemeral: true });

  if (!hasModAccess(interaction.user.id)) {
    await interaction.editReply({
      content: 'You do not have permission to use this command.'
    });
    return;
  }

  try {
    const target = interaction.options.getString('target');
    let userId: string | null = null;
    let deckName: string | null = null;
    let isUserTarget = false;
    let isSpecialFilter = false;

    // Determine if target is a user mention, deck name, or special filter
    if (target) {
      const userMatch = target.match(/<@!?(\d+)>/);
      if (userMatch) {
        userId = userMatch[1];
        isUserTarget = true;
      } else if (['decay', 'set', 'undo', 'admin', 'restricted'].includes(target.toLowerCase())) {
        isSpecialFilter = true;
      } else {
        deckName = normalizeCommanderName(target);
        isUserTarget = false;
      }
    }

    let historyText: string;
    let baseFilename: string;

    if (target) {
      if (isUserTarget && userId) {
        historyText = await generatePlayerHistory(userId, interaction);
        const user = await interaction.client.users.fetch(userId).catch(() => null);
        const username = user?.username || `User_${userId}`;
        baseFilename = `player_history_${username}_${Date.now()}`;
      } else if (isSpecialFilter) {
        historyText = await generateFilteredHistory(target.toLowerCase(), interaction);
        baseFilename = `${target.toLowerCase()}_history_${Date.now()}`;
      } else if (deckName) {
        // Check if deck exists in database
        const { getDatabase } = await import('../db/init.js');
        const db = getDatabase();
        const deckExists = await db.get('SELECT normalizedName FROM decks WHERE normalizedName = ?', deckName);
        
        if (!deckExists) {
          await interaction.editReply({
            content: `❌ Commander "${target}" not found in database. Use the exact normalized name.`
          });
          return;
        }
        
        historyText = await generateDeckHistory(deckName!, target, interaction);
        baseFilename = `deck_history_${target.replace(/[^a-zA-Z0-9-]/g, '_')}_${Date.now()}`;
      } else {
        await interaction.editReply({
          content: 'Invalid target format. Use @user mention, commander-name, "decay", "set", "undo", "admin", "restricted", or leave blank for full history.'
        });
        return;
      }
    } else {
      historyText = await generateFullLeagueHistory(interaction);
      baseFilename = `full_league_history_${Date.now()}`;
    }

    // Split into multiple files if needed
    const files = await splitIntoFiles(historyText, baseFilename);

    // Send via DM to the admin
    const adminUser = await interaction.client.users.fetch(interaction.user.id);
    
    // Send files in batches (Discord allows up to 10 files per message)
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const attachments = batch.map(file => new AttachmentBuilder(file.buffer, { name: file.filename }));
      
      const isFirstBatch = i === 0;
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(files.length / batchSize);
      
      let messageContent = '';
      if (isFirstBatch) {
        messageContent = `📄 **League History Export**\n\n`;
        if (files.length > 1) {
          messageContent += `Split into ${files.length} files due to size (${totalBatches} messages)\n`;
        }
        messageContent += `Generated: ${new Date().toLocaleString()}\n`;
        messageContent += `Total Size: ${(files.reduce((sum, f) => sum + f.buffer.length, 0) / 1024).toFixed(1)}KB\n\n`;
        
        if (totalBatches > 1) {
          messageContent += `**Message ${batchNumber}/${totalBatches}**\n`;
        }
        
        messageContent += `Files in this message:\n${batch.map(f => `• ${f.filename}`).join('\n')}`;
      } else {
        messageContent = `**Message ${batchNumber}/${totalBatches}** - League History Export (continued)\n\n`;
        messageContent += `Files in this message:\n${batch.map(f => `• ${f.filename}`).join('\n')}`;
      }

      await adminUser.send({
        content: messageContent,
        files: attachments
      });
    }

    let replyMessage = `✅ History export completed! ${files.length} file${files.length > 1 ? 's' : ''} sent to your DMs.`;
    if (files.length > 1) {
      replyMessage += `\n📂 Split into ${files.length} files due to Discord size limits.`;
    }

    await interaction.editReply({
      content: replyMessage
    });

  } catch (error) {
    console.error('Error in print command:', error);
    await interaction.editReply({
      content: `❌ An error occurred while generating history: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
}

// Helper function to split large text into multiple files
async function splitIntoFiles(text: string, baseFilename: string): Promise<Array<{buffer: Buffer, filename: string}>> {
  const maxSize = 9 * 1024 * 1024; // 9MB limit to be safe
  const buffer = Buffer.from(text, 'utf-8');
  
  // If it fits in one file, return as single file
  if (buffer.length <= maxSize) {
    return [{
      buffer,
      filename: `${baseFilename}.txt`
    }];
  }
  
  // Split into multiple files
  const files: Array<{buffer: Buffer, filename: string}> = [];
  const lines = text.split('\n');
  let currentChunk = '';
  let fileNumber = 1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] + '\n';
    const testChunk = currentChunk + line;
    const testBuffer = Buffer.from(testChunk, 'utf-8');
    
    // If adding this line would exceed the limit, save current chunk and start new one
    if (testBuffer.length > maxSize && currentChunk.length > 0) {
      // Add file splitting indicator
      const chunkWithFooter = currentChunk + 
        '\n\n═══════════════════════════════════════════════════════════════════════════════\n' +
        `                      END OF PART ${fileNumber} - CONTINUED IN NEXT FILE                      \n` +
        '═══════════════════════════════════════════════════════════════════════════════\n';
      
      files.push({
        buffer: Buffer.from(chunkWithFooter, 'utf-8'),
        filename: `${baseFilename}_part${fileNumber}.txt`
      });
      
      // Start new chunk with header
      currentChunk = '═══════════════════════════════════════════════════════════════════════════════\n' +
        `                      PART ${fileNumber + 1} - CONTINUED FROM PREVIOUS FILE                      \n` +
        '═══════════════════════════════════════════════════════════════════════════════\n\n' + line;
      fileNumber++;
    } else {
      currentChunk = testChunk;
    }
  }
  
  // Add the final chunk
  if (currentChunk.length > 0) {
    const chunkWithFooter = currentChunk + 
      '\n\n═══════════════════════════════════════════════════════════════════════════════\n' +
      `                      END OF PART ${fileNumber} - EXPORT COMPLETE                      \n` +
      '═══════════════════════════════════════════════════════════════════════════════\n';
    
    files.push({
      buffer: Buffer.from(chunkWithFooter, 'utf-8'),
      filename: `${baseFilename}_part${fileNumber}.txt`
    });
  }
  
  return files;
}

function normalizeCommanderName(name: string): string {
  return name.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function generateFilteredHistory(filterType: string, interaction: ChatInputCommandInteraction): Promise<string> {
  let output = '';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += `                           ${filterType.toUpperCase()} HISTORY                           \n`;
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += `Generated: ${new Date().toLocaleString()}\n`;
  output += `Filter Type: ${filterType}\n\n`;

  if (filterType === 'admin') {
    output += await generateAdminActivityReport(interaction);
  } else if (filterType === 'restricted') {
    output += await generateRestrictedPlayersReport(interaction);
  } else if (filterType === 'decay') {
    // FIXED: Remove limit to get ALL decay changes
    const changes = await getAllRatingChanges(999999, 'decay');
    output += `📉 DECAY HISTORY (${changes.length} entries)\n`;
    output += '═'.repeat(80) + '\n';
    
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      output += `\n⏰ Decay ${i + 1}: ${change.targetDisplayName} (${change.targetType})\n`;
      output += `📅 Date: ${new Date(change.timestamp || '').toLocaleString()}\n`;
      
      if (change.parameters) {
        try {
          const params = JSON.parse(change.parameters);
          output += `🕐 Days Inactive: ${params.daysSinceLastPlayed || 'Unknown'}\n`;
        } catch {
          output += `🕐 Automatic decay applied\n`;
        }
      }
      
      const eloDiff = change.newElo - change.oldElo;
      output += `📊 Before: ${change.oldElo} Elo (μ=${change.oldMu.toFixed(2)}, σ=${change.oldSigma.toFixed(2)})\n`;
      output += `📈 After:  ${change.newElo} Elo (μ=${change.newMu.toFixed(2)}, σ=${change.newSigma.toFixed(2)})\n`;
      output += `📉 Change: ${eloDiff >= 0 ? '+' : ''}${eloDiff} Elo\n`;
      
      // FIXED: Always show W/L/D if available
      if (change.oldWins !== undefined && change.oldWins !== null && 
          change.newWins !== undefined && change.newWins !== null) {
        output += `📊 Record: ${change.oldWins}W/${change.oldLosses || 0}L/${change.oldDraws || 0}D → ${change.newWins}W/${change.newLosses || 0}L/${change.newDraws || 0}D\n`;
      }
      
      if (i < changes.length - 1) {
        output += '─'.repeat(40) + '\n';
      }
    }
  } else if (filterType === 'set') {
    // Get ALL /set command changes
    const manualChanges = await getAllRatingChanges(999999, 'manual');
    const wldChanges = await getAllRatingChanges(999999, 'wld_adjustment');
    const allChanges = [...manualChanges, ...wldChanges].sort((a, b) =>
      new Date(b.timestamp || '').getTime() - new Date(a.timestamp || '').getTime()
    );

    output += `🔧 /SET COMMAND HISTORY (${allChanges.length} entries)\n`;
    output += '═'.repeat(80) + '\n';

    for (let i = 0; i < allChanges.length; i++) {
      const change = allChanges[i];
      output += `\n🔧 Set ${i + 1}: ${change.targetDisplayName} (${change.targetType})\n`;
      output += `📅 Date: ${new Date(change.timestamp || '').toLocaleString()}\n`;
      
      try {
        const admin = await interaction.client.users.fetch(change.adminUserId!);
        output += `👤 Admin: @${admin.username}\n`;
      } catch {
        output += `👤 Admin: <@${change.adminUserId}>\n`;
      }
      
      if (change.parameters) {
        try {
          const params = JSON.parse(change.parameters);
          output += `⚙️ Parameters: ${Object.entries(params).map(([k, v]) => `${k}:${v}`).join(' ')}\n`;
        } catch {
          output += `⚙️ Parameters: ${change.parameters}\n`;
        }
      }
      
      if (change.changeType === 'wld_adjustment') {
        // FIXED: Always show W/L/D for wld_adjustment
        output += `📊 Record Change: ${change.oldWins || 0}W/${change.oldLosses || 0}L/${change.oldDraws || 0}D → ${change.newWins || 0}W/${change.newLosses || 0}L/${change.newDraws || 0}D\n`;
        output += `📈 Rating: ${change.oldElo} Elo (unchanged)\n`;
      } else {
        const eloDiff = change.newElo - change.oldElo;
        output += `📊 Before: ${change.oldElo} Elo (μ=${change.oldMu.toFixed(2)}, σ=${change.oldSigma.toFixed(2)})\n`;
        output += `📈 After:  ${change.newElo} Elo (μ=${change.newMu.toFixed(2)}, σ=${change.newSigma.toFixed(2)})\n`;
        output += `📉 Change: ${eloDiff >= 0 ? '+' : ''}${eloDiff} Elo\n`;
        
        // FIXED: Always show W/L/D if available
        if (change.oldWins !== undefined && change.oldWins !== null && 
            change.newWins !== undefined && change.newWins !== null) {
          output += `📊 Record: ${change.oldWins}W/${change.oldLosses || 0}L/${change.oldDraws || 0}D → ${change.newWins}W/${change.newLosses || 0}L/${change.newDraws || 0}D\n`;
        }
      }
      
      if (i < allChanges.length - 1) {
        output += '─'.repeat(40) + '\n';
      }
    }
  } else if (filterType === 'undo') {
    // FIXED: Remove limit to get ALL undo changes
    const undoChanges = await getAllRatingChanges(999999, 'undo');
    output += `↩️ UNDO/REDO HISTORY (${undoChanges.length} entries)\n`;
    output += '═'.repeat(80) + '\n';
    
    for (let i = 0; i < undoChanges.length; i++) {
      const change = undoChanges[i];
      output += `\n↩️ Undo/Redo ${i + 1}: ${change.targetDisplayName} (${change.targetType})\n`;
      output += `📅 Date: ${new Date(change.timestamp || '').toLocaleString()}\n`;
      
      try {
        const admin = await interaction.client.users.fetch(change.adminUserId!);
        output += `👤 Admin: @${admin.username}\n`;
      } catch {
        output += `👤 Admin: <@${change.adminUserId}>\n`;
      }
      
      if (change.parameters) {
        try {
          const params = JSON.parse(change.parameters);
          output += `🎮 Game ID: ${params.gameId || 'Unknown'}\n`;
          output += `🔄 Action: ${params.action || 'Unknown'}\n`;
        } catch {
          output += `🔄 Undo/Redo operation\n`;
        }
      }
      
      const eloDiff = change.newElo - change.oldElo;
      output += `📊 Before: ${change.oldElo} Elo (μ=${change.oldMu.toFixed(2)}, σ=${change.oldSigma.toFixed(2)})\n`;
      output += `📈 After:  ${change.newElo} Elo (μ=${change.newMu.toFixed(2)}, σ=${change.newSigma.toFixed(2)})\n`;
      output += `📉 Change: ${eloDiff >= 0 ? '+' : ''}${eloDiff} Elo\n`;
      
      // FIXED: Always show W/L/D if available
      if (change.oldWins !== undefined && change.oldWins !== null && 
          change.newWins !== undefined && change.newWins !== null) {
        output += `📊 Record: ${change.oldWins}W/${change.oldLosses || 0}L/${change.oldDraws || 0}D → ${change.newWins}W/${change.newLosses || 0}L/${change.newDraws || 0}D\n`;
      }
      
      if (i < undoChanges.length - 1) {
        output += '─'.repeat(40) + '\n';
      }
    }
  }

  output += '\n\n═══════════════════════════════════════════════════════════════════════════════\n';
  output += `                            END OF ${filterType.toUpperCase()} HISTORY                           \n`;
  output += '═══════════════════════════════════════════════════════════════════════════════\n';

  return output;
}

async function generateAdminActivityReport(interaction: ChatInputCommandInteraction): Promise<string> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();
  
  let output = '';
  output += `👑 ADMIN ACTIVITY REPORT\n`;
  output += '═'.repeat(80) + '\n';
  
  // Get all admin actions from rating changes
  const adminActions = await db.all(`
    SELECT adminUserId, changeType, COUNT(*) as count, 
           MIN(timestamp) as firstAction, MAX(timestamp) as lastAction
    FROM rating_changes 
    WHERE adminUserId IS NOT NULL
    GROUP BY adminUserId, changeType
    ORDER BY adminUserId, changeType
  `);
  
  // Get admin-submitted games
  const adminGames = await db.all(`
    SELECT submittedBy, COUNT(*) as gameCount,
           MIN(createdAt) as firstGame, MAX(createdAt) as lastGame
    FROM games_master 
    WHERE submittedByAdmin = 1
    GROUP BY submittedBy
    ORDER BY gameCount DESC
  `);
  
  output += `\n📊 ADMIN ACTION SUMMARY:\n`;
  for (const admin of config.admins) {
    try {
      const user = await interaction.client.users.fetch(admin);
      output += `\n👤 @${user.username} (${admin}):\n`;
    } catch {
      output += `\n👤 <@${admin}>:\n`;
    }
    
    const userActions = adminActions.filter(a => a.adminUserId === admin);
    const userGames = adminGames.find(g => g.submittedBy === admin);
    
    if (userActions.length === 0 && !userGames) {
      output += `   No admin actions recorded\n`;
    } else {
      if (userGames) {
        output += `   🎮 Games Submitted: ${userGames.gameCount}\n`;
        output += `   📅 First Game: ${new Date(userGames.firstGame).toLocaleString()}\n`;
        output += `   📅 Last Game: ${new Date(userGames.lastGame).toLocaleString()}\n`;
      }
      
      for (const action of userActions) {
        output += `   ${getActionEmoji(action.changeType)} ${action.changeType}: ${action.count} times\n`;
        output += `     📅 First: ${new Date(action.firstAction).toLocaleString()}\n`;
        output += `     📅 Last: ${new Date(action.lastAction).toLocaleString()}\n`;
      }
    }
  }
  
  return output;
}

async function generateRestrictedPlayersReport(interaction: ChatInputCommandInteraction): Promise<string> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();
  
  let output = '';
  output += `🚫 RESTRICTED PLAYERS REPORT\n`;
  output += '═'.repeat(80) + '\n';
  
  const restrictedPlayers = await db.all('SELECT userId FROM restricted ORDER BY userId');
  
  if (restrictedPlayers.length === 0) {
    output += `No restricted players found.\n`;
  } else {
    output += `📊 Total Restricted Players: ${restrictedPlayers.length}\n\n`;
    
    for (let i = 0; i < restrictedPlayers.length; i++) {
      const player = restrictedPlayers[i];
      try {
        const user = await interaction.client.users.fetch(player.userId);
        output += `${i + 1}. @${user.username} (${player.userId})\n`;
      } catch {
        output += `${i + 1}. <@${player.userId}> (${player.userId})\n`;
      }
      
      const playerStats = await db.get('SELECT * FROM players WHERE userId = ?', player.userId);
      if (playerStats) {
        const elo = calculateElo(playerStats.mu, playerStats.sigma);
        output += `   📈 Rating: ${elo} Elo\n`;
        output += `   📊 Record: ${playerStats.wins || 0}W/${playerStats.losses || 0}L/${playerStats.draws || 0}D\n`;
        if (playerStats.lastPlayed) {
          output += `   📅 Last Played: ${new Date(playerStats.lastPlayed).toLocaleString()}\n`;
        }
      } else {
        output += `   ❌ No game history found\n`;
      }
      
      if (i < restrictedPlayers.length - 1) {
        output += '\n';
      }
    }
  }
  
  return output;
}

function getActionEmoji(changeType: string): string {
  switch (changeType) {
    case 'manual': return '🔧';
    case 'wld_adjustment': return '📊';
    case 'undo': return '↩️';
    case 'decay': return '📉';
    default: return '⚙️';
  }
}

async function generateRatingChangeHistory(
  targetType: 'player' | 'deck', 
  targetId: string, 
  interaction: ChatInputCommandInteraction
): Promise<string> {
  let output = '';
  
  output += `\n\n🔧 RATING CHANGE HISTORY\n`;
  output += '═'.repeat(80) + '\n';
  
  // FIXED: Remove limit to get ALL changes
  const changes = await getRatingChangesForTarget(targetType, targetId, 999999);
  
  if (changes.length === 0) {
    output += 'No rating changes found.\n';
    return output;
  }
  
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const changeNum = changes.length - i;
    
    output += `\n🔧 Change ${changeNum}: ${change.changeType.toUpperCase()}\n`;
    output += `📅 Date: ${new Date(change.timestamp || '').toLocaleString()}\n`;
    
    if (change.changeType === 'manual' && change.adminUserId) {
      try {
        const admin = await interaction.client.users.fetch(change.adminUserId);
        output += `👤 Admin: @${admin.username}\n`;
      } catch {
        output += `👤 Admin: <@${change.adminUserId}>\n`;
      }
      
      if (change.parameters) {
        try {
          const params = JSON.parse(change.parameters);
          output += `⚙️ Parameters: ${Object.entries(params).map(([k, v]) => `${k}:${v}`).join(' ')}\n`;
        } catch {
          output += `⚙️ Parameters: ${change.parameters}\n`;
        }
      }
    } else if (change.changeType === 'wld_adjustment' && change.adminUserId) {
      try {
        const admin = await interaction.client.users.fetch(change.adminUserId);
        output += `👤 Admin: @${admin.username}\n`;
      } catch {
        output += `👤 Admin: <@${change.adminUserId}>\n`;
      }
      // FIXED: Always show W/L/D for wld_adjustment
      output += `📊 W/L/D Change: ${change.oldWins || 0}W/${change.oldLosses || 0}L/${change.oldDraws || 0}D → ${change.newWins || 0}W/${change.newLosses || 0}L/${change.newDraws || 0}D\n`;
      output += `📈 Rating: ${change.oldElo} Elo (unchanged)\n`;
      continue;
    } else if (change.changeType === 'game' && change.parameters) {
      try {
        const params = JSON.parse(change.parameters);
        output += `🎮 Game ID: ${params.gameId || 'Unknown'}\n`;
        output += `🎲 Result: ${(params.result === 'w' ? '🏆 WIN' : params.result === 'd' ? '🤝 DRAW' : '💀 LOSS')}\n`;
        if (params.turnOrder) output += `🔢 Turn Order: ${params.turnOrder}\n`;
        if (params.commander) {output += `🃏 Commander: ${params.commander}\n`;}
        if (params.submittedByAdmin !== undefined) output += `👑 Admin Submitted: ${params.submittedByAdmin ? 'Yes' : 'No'}\n`;
      } catch {
        output += `🎮 Game result\n`;
      }
    } else if (change.changeType === 'decay' && change.parameters) {
      try {
        const params = JSON.parse(change.parameters);
        output += `⏰ Days Inactive: ${params.daysSinceLastPlayed || 'Unknown'}\n`;
      } catch {
        output += `⏰ Rating decay applied\n`;
      }
    } else if (change.changeType === 'undo' && change.parameters) {
      try {
        const params = JSON.parse(change.parameters);
        output += `🎮 Game ID: ${params.gameId || 'Unknown'}\n`;
        output += `🔄 Action: ${params.action || 'Undo/Redo'}\n`;
      } catch {
        output += `↩️ Undo/Redo operation\n`;
      }
    }
    
    const eloDiff = change.newElo - change.oldElo;
    const muDiff = change.newMu - change.oldMu;
    const sigmaDiff = change.newSigma - change.oldSigma;
    
    output += `📊 Before: ${change.oldElo} Elo (μ=${change.oldMu.toFixed(2)}, σ=${change.oldSigma.toFixed(2)})\n`;
    output += `📈 After:  ${change.newElo} Elo (μ=${change.newMu.toFixed(2)}, σ=${change.newSigma.toFixed(2)})\n`;
    output += `📉 Change: ${eloDiff >= 0 ? '+' : ''}${eloDiff} Elo (μ${muDiff >= 0 ? '+' : ''}${muDiff.toFixed(3)}, σ${sigmaDiff >= 0 ? '+' : ''}${sigmaDiff.toFixed(3)})\n`;
    
    // FIXED: Always show W/L/D if available
    if (change.oldWins !== undefined && change.oldWins !== null && 
        change.newWins !== undefined && change.newWins !== null) {
      const winDiff = change.newWins - change.oldWins;
      const lossDiff = (change.newLosses || 0) - (change.oldLosses || 0);
      const drawDiff = (change.newDraws || 0) - (change.oldDraws || 0);
      if (winDiff !== 0 || lossDiff !== 0 || drawDiff !== 0) {
        output += `📊 Record: ${change.oldWins}W/${change.oldLosses || 0}L/${change.oldDraws || 0}D → ${change.newWins}W/${change.newLosses || 0}L/${change.newDraws || 0}D `;
        output += `(${winDiff >= 0 ? '+' : ''}${winDiff}W ${lossDiff >= 0 ? '+' : ''}${lossDiff}L ${drawDiff >= 0 ? '+' : ''}${drawDiff}D)\n`;
      }
    }
    
    if (i < changes.length - 1) {
      output += '─'.repeat(40) + '\n';
    }
  }
  
  return output;
}

async function generateFullLeagueHistory(interaction: ChatInputCommandInteraction): Promise<string> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  let output = '';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += '                           COMPLETE LEAGUE HISTORY                           \n';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += `Generated: ${new Date().toLocaleString()}\n`;
  output += `Export Type: Full League History\n\n`;

  // Get league statistics
  const playerCount = await db.get('SELECT COUNT(*) as count FROM players WHERE wins + losses + draws > 0');
  const allPlayersCount = await db.get('SELECT COUNT(*) as count FROM players');
  const restrictedCount = await db.get('SELECT COUNT(*) as count FROM restricted');
  const deckCount = await db.get('SELECT COUNT(*) as count FROM decks WHERE wins + losses + draws > 0');
  const playerGameCount = await db.get('SELECT COUNT(DISTINCT gameId) as count FROM matches');
  const deckGameCount = await db.get('SELECT COUNT(DISTINCT gameId) as count FROM deck_matches');
  const adminGameCount = await db.get('SELECT COUNT(DISTINCT gameId) as count FROM games_master WHERE submittedByAdmin = 1');
  const inactiveGameCount = await db.get('SELECT COUNT(*) as count FROM games_master WHERE active = 0');

  output += '📊 LEAGUE SUMMARY\n';
  output += '─'.repeat(50) + '\n';
  output += `Active Players: ${playerCount?.count || 0}\n`;
  output += `Total Players: ${allPlayersCount?.count || 0}\n`;
  output += `Restricted Players: ${restrictedCount?.count || 0}\n`;
  output += `Active Decks: ${deckCount?.count || 0}\n`;
  output += `Total Player Games: ${playerGameCount?.count || 0}\n`;
  output += `Total Deck Games: ${deckGameCount?.count || 0}\n`;
  output += `Admin Submitted Games: ${adminGameCount?.count || 0}\n`;
  output += `Deactivated Games: ${inactiveGameCount?.count || 0}\n\n`;

  // FIXED: Get ALL rating changes without limit
  const allChanges = await getAllRatingChanges(999999);
  output += `🔧 COMPLETE AUDIT TRAIL (${allChanges.length} entries)\n`;
  output += '═'.repeat(80) + '\n';

  for (let i = 0; i < allChanges.length; i++) {
    const change = allChanges[i];
    output += `\n🔧 Entry ${i + 1}: ${change.targetDisplayName} (${change.targetType}) - ${change.changeType.toUpperCase()}\n`;
    output += `📅 Date: ${new Date(change.timestamp || '').toLocaleString()}\n`;
    
    if (change.adminUserId) {
      try {
        const admin = await interaction.client.users.fetch(change.adminUserId);
        output += `👤 Admin: @${admin.username}\n`;
      } catch {
        output += `👤 Admin: <@${change.adminUserId}>\n`;
      }
    }
    
    if (change.changeType === 'game' && change.parameters) {
      try {
        const params = JSON.parse(change.parameters);
        if (params.submittedByAdmin !== undefined) {
          output += `👑 Admin Submitted: ${params.submittedByAdmin ? 'Yes' : 'No'}\n`;
        }
      } catch {
        // Ignore parsing errors
      }
    }
    
    const eloDiff = change.newElo - change.oldElo;
    output += `📈 Elo: ${change.oldElo} → ${change.newElo} (${eloDiff >= 0 ? '+' : ''}${eloDiff})\n`;
    
    // FIXED: Always show W/L/D if available
    if (change.oldWins !== undefined && change.oldWins !== null && 
        change.newWins !== undefined && change.newWins !== null) {
      output += `📊 Record: ${change.oldWins}W/${change.oldLosses || 0}L/${change.oldDraws || 0}D → ${change.newWins}W/${change.newLosses || 0}L/${change.newDraws || 0}D\n`;
    }
    
    if (i < allChanges.length - 1) {
      output += '─'.repeat(20) + '\n';
    }
  }

  output += '\n\n═══════════════════════════════════════════════════════════════════════════════\n';
  output += '                            END OF LEAGUE HISTORY                           \n';
  output += '═══════════════════════════════════════════════════════════════════════════\n';
  return output;
}

async function generatePlayerHistory(userId: string, interaction: ChatInputCommandInteraction): Promise<string> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  let output = '';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += '                             PLAYER GAME HISTORY                            \n';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';

  try {
    const user = await interaction.client.users.fetch(userId);
    output += `Player: @${user.username}\n`;
  } catch {
    output += `Player: <@${userId}>\n`;
  }

  output += `User ID: ${userId}\n`;
  output += `Generated: ${new Date().toLocaleString()}\n\n`;

  const isRestricted = await db.get('SELECT userId FROM restricted WHERE userId = ?', userId);
  if (isRestricted) {
    output += '🚫 RESTRICTED PLAYER\n';
    output += '─'.repeat(50) + '\n';
  }

  const playerStats = await db.get(`SELECT * FROM players WHERE userId = ?`, userId);

  if (!playerStats) {
    output += '❌ Player not found in database.\n';
    return output;
  }

  const currentElo = calculateElo(playerStats.mu, playerStats.sigma);
  output += '📊 CURRENT STATISTICS\n';
  output += '─'.repeat(50) + '\n';
  output += `Rating: ${currentElo} Elo (μ=${playerStats.mu.toFixed(2)}, σ=${playerStats.sigma.toFixed(2)})\n`;
  output += `Record: ${playerStats.wins || 0}W/${playerStats.losses || 0}L/${playerStats.draws || 0}D\n`;
  output += `Total Games: ${(playerStats.wins || 0) + (playerStats.losses || 0) + (playerStats.draws || 0)}\n`;
  if (playerStats.lastPlayed) {
    output += `Last Played: ${new Date(playerStats.lastPlayed).toLocaleString()}\n`;
  }
  output += '\n';

  const games = await db.all(`
    SELECT DISTINCT 
      gm.gameId, 
      gm.gameSequence, 
      gm.submittedBy,
      gm.submittedByAdmin,
      gm.active,
      m.matchDate,
      gm.status
    FROM games_master gm
    JOIN matches m ON gm.gameId = m.gameId
    WHERE m.userId = ? AND gm.gameType = 'player'
    ORDER BY gm.gameSequence ASC
  `, userId);

  output += `🎮 GAME HISTORY (${games.length} games)\n`;
  output += '═'.repeat(80) + '\n';

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    
    const playerMatch = await db.get(`
      SELECT * FROM matches 
      WHERE gameId = ? AND userId = ?
    `, game.gameId, userId);

    const allMatches = await db.all(`
      SELECT * FROM matches 
      WHERE gameId = ? AND userId != ?
      ORDER BY matchDate ASC
    `, game.gameId, userId);

    if (!playerMatch) continue;

    const activeStatus = game.active === 0 ? ' | INACTIVE' : '';
    output += `\n🎯 Game ${i + 1}: ${game.gameId} | Sequence: ${game.gameSequence} | ${game.status.toUpperCase()}${activeStatus}\n`;
    output += `📅 Date: ${new Date(game.matchDate).toLocaleString()}\n`;
    output += `👑 Admin Submitted: ${game.submittedByAdmin ? 'Yes' : 'No'}\n`;
    
    try {
      const submitter = await interaction.client.users.fetch(game.submittedBy);
      output += `👤 Submitted by: @${submitter.username}\n`;
    } catch {
      output += `👤 Submitted by: <@${game.submittedBy}>\n`;
    }

    const result = playerMatch.status === 'w' ? '🏆 WIN' : playerMatch.status === 'd' ? '🤝 DRAW' : '💀 LOSS';
    const turnInfo = playerMatch.turnOrder ? ` | Turn Order: ${playerMatch.turnOrder}` : ' | Turn Order: Unknown';
    const elo = calculateElo(playerMatch.mu, playerMatch.sigma);
    
    output += `🎲 YOUR RESULT: ${result}${turnInfo}\n`;
    if (playerMatch.assignedDeck) {
        const deckData = await db.get('SELECT displayName FROM decks WHERE normalizedName = ?', playerMatch.assignedDeck);
  const commanderDisplay = deckData?.displayName || playerMatch.assignedDeck;
  output += `🃏 Commander Used: ${commanderDisplay}\n`;
    }
    output += `📈 Rating After Game: ${elo} Elo (μ=${playerMatch.mu.toFixed(2)}, σ=${playerMatch.sigma.toFixed(2)})\n`;
    output += `👥 Opponents (${allMatches.length}):\n`;

    for (const opponent of allMatches) {
      try {
        const opponentUser = await interaction.client.users.fetch(opponent.userId);
        const opponentResult = opponent.status === 'w' ? '🏆' : opponent.status === 'd' ? '🤝' : '💀';
        const opponentTurn = opponent.turnOrder ? ` (Turn ${opponent.turnOrder})` : ' (Turn ?)';
        const opponentDeck = opponent.assignedDeck ? ` [${opponent.assignedDeck}]` : '';
        output += `  ${opponentResult} @${opponentUser.username}${opponentTurn}${opponentDeck}\n`;
      } catch {
        const opponentResult = opponent.status === 'w' ? '🏆' : opponent.status === 'd' ? '🤝' : '💀';
        const opponentTurn = opponent.turnOrder ? ` (Turn ${opponent.turnOrder})` : ' (Turn ?)';
        const opponentDeck = opponent.assignedDeck ? ` [${opponent.assignedDeck}]` : '';
        output += `  ${opponentResult} <@${opponent.userId}>${opponentTurn}${opponentDeck}\n`;
      }
    }
  }

  output += '\n\n═══════════════════════════════════════════════════════════════════════════════\n';
  output += '                          END OF PLAYER HISTORY                           \n';
  output += '═══════════════════════════════════════════════════════════════════════════\n';
  output += await generateRatingChangeHistory('player', userId, interaction);
  return output;
}

async function generateDeckHistory(deckNormalizedName: string, originalName: string, interaction: ChatInputCommandInteraction): Promise<string> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  let output = '';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += '                              DECK GAME HISTORY                             \n';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';

  const deckStats = await db.get(`SELECT * FROM decks WHERE normalizedName = ?`, deckNormalizedName);

  if (!deckStats) {
    output += `❌ Deck "${originalName}" not found in database.\n`;
    return output;
  }

  output += `Commander: ${deckStats.displayName}\n`;
  output += `Normalized Name: ${deckNormalizedName}\n`;
  output += `Generated: ${new Date().toLocaleString()}\n\n`;

  const currentElo = calculateElo(deckStats.mu, deckStats.sigma);
  output += '📊 CURRENT STATISTICS\n';
  output += '─'.repeat(50) + '\n';
  output += `Rating: ${currentElo} Elo (μ=${deckStats.mu.toFixed(2)}, σ=${deckStats.sigma.toFixed(2)})\n`;
  output += `Record: ${deckStats.wins || 0}W/${deckStats.losses || 0}L/${deckStats.draws || 0}D\n`;
  output += `Total Games: ${(deckStats.wins || 0) + (deckStats.losses || 0) + (deckStats.draws || 0)}\n`;
  
  const assignedPlayers = await db.all(`
    SELECT DISTINCT m.userId, COUNT(*) as gameCount
    FROM matches m 
    WHERE m.assignedDeck = ? 
    GROUP BY m.userId
    ORDER BY gameCount DESC
  `, deckStats.displayName);
  
  if (assignedPlayers.length > 0) {
    output += `\n🃏 ASSIGNED TO PLAYERS:\n`;
    for (const assignment of assignedPlayers) {
      try {
        const user = await interaction.client.users.fetch(assignment.userId);
        output += `  @${user.username}: ${assignment.gameCount} games\n`;
      } catch {
        output += `  <@${assignment.userId}>: ${assignment.gameCount} games\n`;
      }
    }
  }
  output += '\n';

  const games = await db.all(`
    SELECT DISTINCT 
      gm.gameId, 
      gm.gameSequence, 
      gm.submittedBy,
      gm.submittedByAdmin,
      gm.active,
      dm.matchDate,
      gm.status
    FROM games_master gm
    JOIN deck_matches dm ON gm.gameId = dm.gameId
    WHERE dm.deckNormalizedName = ? AND gm.gameType = 'deck'
    ORDER BY gm.gameSequence ASC
  `, deckNormalizedName);

  output += `🃏 GAME HISTORY (${games.length} games)\n`;
  output += '═'.repeat(80) + '\n';

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    
    const deckMatch = await db.get(`
      SELECT * FROM deck_matches 
      WHERE gameId = ? AND deckNormalizedName = ?
    `, game.gameId, deckNormalizedName);

    const allMatches = await db.all(`
      SELECT * FROM deck_matches 
      WHERE gameId = ? AND deckNormalizedName != ?
      ORDER BY matchDate ASC
    `, game.gameId, deckNormalizedName);

    if (!deckMatch) continue;

    const activeStatus = game.active === 0 ? ' | INACTIVE' : '';
    output += `\n🎯 Game ${i + 1}: ${game.gameId} | Sequence: ${game.gameSequence} | ${game.status.toUpperCase()}${activeStatus}\n`;
    output += `📅 Date: ${new Date(game.matchDate).toLocaleString()}\n`;
    output += `👑 Admin Submitted: ${game.submittedByAdmin ? 'Yes' : 'No'}\n`;

    const result = deckMatch.status === 'w' ? '🏆 WIN' : deckMatch.status === 'd' ? '🤝 DRAW' : '💀 LOSS';
    const turnInfo = deckMatch.turnOrder ? ` | Turn Order: ${deckMatch.turnOrder}` : ' | Turn Order: Unknown';
    const elo = calculateElo(deckMatch.mu, deckMatch.sigma);
    
    output += `🎲 YOUR RESULT: ${result}${turnInfo}\n`;
    output += `📈 Rating After Game: ${elo} Elo (μ=${deckMatch.mu.toFixed(2)}, σ=${deckMatch.sigma.toFixed(2)})\n`;
    output += `🃏 Other Decks (${allMatches.length}):\n`;

    for (const opponent of allMatches) {
      const opponentResult = opponent.status === 'w' ? '🏆' : opponent.status === 'd' ? '🤝' : '💀';
      const opponentTurn = opponent.turnOrder ? ` (Turn ${opponent.turnOrder})` : ' (Turn ?)';
      output += `  ${opponentResult} ${opponent.deckDisplayName}${opponentTurn}\n`;
    }
  }

  output += '\n\n═══════════════════════════════════════════════════════════════════════════════\n';
  output += '                            END OF DECK HISTORY                            \n';
  output += '═══════════════════════════════════════════════════════════════════════════\n';
  output += await generateRatingChangeHistory('deck', deckNormalizedName, interaction);
  return output;
}