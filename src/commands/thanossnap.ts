import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder
} from 'discord.js';
import fs from 'node:fs/promises';
import fsSync from 'fs';
import path from 'node:path';
import { getAllPlayers, getRestrictedPlayers } from '../db/player-utils.js';
import { getAllDecks } from '../db/deck-utils.js';
import { config } from '../config.js';
import { calculateElo } from '../utils/elo-utils.js';
import { getDatabase } from '../db/init.js';
import type { ExtendedClient } from '../bot.js';
import { logger } from '../utils/logger.js';

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

// Helper function to split database file into multiple parts (copied from backup.ts)
async function splitDatabaseIntoFiles(dbPath: string, baseFilename: string): Promise<Array<{buffer: Buffer, filename: string}>> {
  const maxSize = 9 * 1024 * 1024; // 9MB limit to be safe
  const dbBuffer = fsSync.readFileSync(dbPath);
  
  // If it fits in one file, return as single file
  if (dbBuffer.length <= maxSize) {
    return [{
      buffer: dbBuffer,
      filename: `${baseFilename}.db`
    }];
  }
  
  // Split into multiple files
  const files: Array<{buffer: Buffer, filename: string}> = [];
  let offset = 0;
  let partNumber = 1;
  
  while (offset < dbBuffer.length) {
    const remainingBytes = dbBuffer.length - offset;
    const chunkSize = Math.min(maxSize, remainingBytes);
    const chunk = dbBuffer.subarray(offset, offset + chunkSize);
    
    files.push({
      buffer: chunk,
      filename: `${baseFilename}_part${partNumber}.db`
    });
    
    offset += chunkSize;
    partNumber++;
  }
  
  return files;
}

export const data = new SlashCommandBuilder()
  .setName('thanossnap')
  .setDescription('Admin: end the season, show qualified top players and decks, and reset all data');

export async function execute(
  interaction: ChatInputCommandInteraction,
  client: ExtendedClient
): Promise<void> {
  if (!config.admins.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'You are not a bot admin.',
      ephemeral: true
    });
    return;
  }

  // Defer reply immediately since this command takes a while
  await interaction.deferReply();

  // 1) Create backup first using SQLite VACUUM
  const dbFile = path.resolve('data', 'cEDHSkill.db');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T');
  const dateStr = timestamp[0]; // YYYY-MM-DD
  const timeStr = timestamp[1].split('.')[0]; // HH-MM-SS
  const baseFilename = `Season-End-Backup-${dateStr}_${timeStr}`;

  // Security: Validate filename contains only safe characters (alphanumeric, dash, underscore)
  if (!/^[A-Za-z0-9_-]+$/.test(baseFilename)) {
    logger.error('[THANOSSNAP] Invalid backup filename generated:', baseFilename);
    await interaction.editReply({
      content: 'Failed to create backup: invalid filename generated.'
    });
    return;
  }

  const dataDir = path.resolve('data');
  const backupFile = path.resolve('data', `${baseFilename}.db`);

  // Security: Ensure backup path stays within data directory (prevent path traversal)
  if (!backupFile.startsWith(dataDir + path.sep)) {
    logger.error('[THANOSSNAP] Path traversal attempt detected:', backupFile);
    await interaction.editReply({
      content: 'Failed to create backup: invalid path.'
    });
    return;
  }

  let backupFiles: Array<{buffer: Buffer, filename: string}> = [];

  try {
    const db = getDatabase();
    // Use forward slashes for SQLite compatibility
    const safePath = backupFile.replace(/\\/g, '/');
    await db.exec(`VACUUM INTO '${safePath}'`);
    logger.info(`[THANOSSNAP] Created clean backup: ${backupFile}`);
    
    // Prepare backup files for DM
    backupFiles = await splitDatabaseIntoFiles(backupFile, baseFilename);
    
  } catch (err) {
    logger.error('[THANOSSNAP] Backup failed:', err);
    await interaction.editReply({
      content: 'Failed to create backup. Season end aborted.'
    });
    return;
  }

  // 2) Build leaderboards - ONLY QUALIFIED PLAYERS AND DECKS (≥5 games), LIMITED TO TOP 64
  const allPlayers = await getAllPlayers();
  const restricted = new Set(await getRestrictedPlayers());
  
  // Filter out restricted players AND only include qualified players (≥5 games)
  const qualifiedPlayers = allPlayers.filter((p: any) => {
    const totalGames = (p.wins || 0) + (p.losses || 0) + (p.draws || 0);
    return !restricted.has(p.userId) && totalGames >= 5;
  });
  
  const rankedPlayers = qualifiedPlayers
    .map((p: any) => ({ id: p.userId, elo: calculateElo(p.mu, p.sigma) }))
    .sort((a: any, b: any) => b.elo - a.elo);
  
  // Handle ties and limit to top 64
  const topPlayers = getTopEntriesWithTies(rankedPlayers, 64, 'elo');
  
  // Apply RANK/POS logic for players
  const playerDescription: string[] = [];
  let currentPlayerRank = 1;
  
  for (let i = 0; i < topPlayers.length; i++) {
    const player = topPlayers[i];
    
    // If not the first player and Elo is different, update rank
    if (i > 0 && player.elo !== topPlayers[i - 1].elo) {
      currentPlayerRank = i + 1;
    }
    
    playerDescription.push(`RANK${currentPlayerRank}/POS${i + 1}. <@${player.id}> — ${player.elo}`);
  }
  
  // Get qualified decks (≥5 games)
  const allDecks = await getAllDecks();
  const qualifiedDecks = allDecks.filter(deck => {
    const totalGames = (deck.wins || 0) + (deck.losses || 0) + (deck.draws || 0);
    return totalGames >= 5;
  });

  const rankedDecks = qualifiedDecks
    .map(deck => ({ 
      name: deck.displayName, 
      elo: calculateElo(deck.mu, deck.sigma) 
    }))
    .sort((a, b) => b.elo - a.elo);

  // Handle ties and limit to top 64
  const topDecks = getTopEntriesWithTies(rankedDecks, 64, 'elo');

  // Apply RANK/POS logic for decks
  const deckDescription: string[] = [];
  let currentDeckRank = 1;
  
  for (let i = 0; i < topDecks.length; i++) {
    const deck = topDecks[i];
    
    // If not the first deck and Elo is different, update rank
    if (i > 0 && deck.elo !== topDecks[i - 1].elo) {
      currentDeckRank = i + 1;
    }
    
    deckDescription.push(`RANK${currentDeckRank}/POS${i + 1}. **${deck.name}** — ${deck.elo}`);
  }

  const playerEmbed = new EmbedBuilder()
    .setTitle('🌌 Season Over: Top 64 Qualified Players')
    .setDescription(
      playerDescription.length > 0
        ? playerDescription.join('\n')
        : 'No qualified players found (minimum 5 games required).'
    )
    .setColor('DarkPurple')
    .setFooter({ 
      text: `Showing top ${topPlayers.length} of ${qualifiedPlayers.length} qualified players (≥5 games)${topPlayers.length > 64 ? ' (expanded due to ties)' : ''}. Total players: ${allPlayers.length}` 
    });

  const deckEmbed = new EmbedBuilder()
    .setTitle('🌌 Season Over: Top 64 Qualified Commanders')
    .setDescription(
      deckDescription.length > 0
        ? deckDescription.join('\n')
        : 'No qualified commanders found (minimum 5 games required).'
    )
    .setColor('Purple')
    .setFooter({ 
      text: `Showing top ${topDecks.length} of ${qualifiedDecks.length} qualified commanders (≥5 games)${topDecks.length > 64 ? ' (expanded due to ties)' : ''}. Total decks: ${allDecks.length}` 
    });

  // 3) Show public rankings
  await interaction.editReply({
    content: 'The universe has been perfectly balanced... as all things should be.',
    embeds: [playerEmbed, deckEmbed]
  });

  // 4) Send backup to all admins and moderators
  const adminModIds = [...config.admins, ...config.moderators];
  const fileSizeMB = (fsSync.statSync(backupFile).size / (1024 * 1024)).toFixed(2);
  
  for (const userId of adminModIds) {
    try {
      const user = await client.users.fetch(userId);
      
      // Send files in batches (Discord allows up to 10 files per message)
      const batchSize = 10;
      for (let i = 0; i < backupFiles.length; i += batchSize) {
        const batch = backupFiles.slice(i, i + batchSize);
        const attachments = batch.map(file => new AttachmentBuilder(file.buffer, { name: file.filename }));
        
        const isFirstBatch = i === 0;
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(backupFiles.length / batchSize);
        
        let messageContent = '';
        if (isFirstBatch) {
          messageContent = `🕹️ **Avengers, assemble!** The season has ended and the database has been reset.\n\n`;
          messageContent += `📊 **Final Season Stats:**\n`;
          messageContent += `• ${qualifiedPlayers.length} qualified players (≥5 games)\n`;
          messageContent += `• ${qualifiedDecks.length} qualified commanders (≥5 games)\n`;
          messageContent += `• ${allPlayers.length} total players participated\n\n`;
          messageContent += `💾 **Season Database Backup:**\n`;
          
          if (backupFiles.length > 1) {
            messageContent += `Database split into ${backupFiles.length} parts due to size (${totalBatches} messages)\n`;
            messageContent += `**Original Size**: ${fileSizeMB}MB\n\n`;
            messageContent += `**To restore this season:**\n`;
            messageContent += `1. Download all ${backupFiles.length} parts\n`;
            messageContent += `2. Reconstruct using: \`copy /b "${baseFilename}_part*.db" "${baseFilename}.db"\`\n`;
            messageContent += `3. Replace the current \`cEDHSkill.db\` with the reconstructed file\n`;
            messageContent += `4. Restart the bot\n\n`;
          } else {
            messageContent += `**Size**: ${fileSizeMB}MB\n\n`;
            messageContent += `**To restore this season:**\n`;
            messageContent += `1. Download the backup file\n`;
            messageContent += `2. Replace the current \`cEDHSkill.db\` with this backup\n`;
            messageContent += `3. Restart the bot\n\n`;
          }
          
          if (totalBatches > 1) {
            messageContent += `**Message ${batchNumber}/${totalBatches}**\n`;
          }
          
          messageContent += `Files in this message:\n${batch.map(f => `• ${f.filename}`).join('\n')}`;
        } else {
          messageContent = `**Message ${batchNumber}/${totalBatches}** - Season Backup (continued)\n\n`;
          messageContent += `Files in this message:\n${batch.map(f => `• ${f.filename}`).join('\n')}`;
        }

        await user.send({
          content: messageContent,
          files: attachments
        });
      }
      
      logger.info(`[THANOSSNAP] Sent backup to ${user.username}`);
      
    } catch (dmError) {
      logger.error(`[THANOSSNAP] Failed to send backup to ${userId}:`, dmError);
    }
  }

  // 5) Reset ALL tables - complete fresh start
  const db = getDatabase();
  try {
    await db.exec('DELETE FROM players');
    await db.exec('DELETE FROM matches');
    await db.exec('DELETE FROM restricted');
    await db.exec('DELETE FROM suspicionExempt');
    await db.exec('DELETE FROM adminOptIn');
    await db.exec('DELETE FROM decks');
    await db.exec('DELETE FROM deck_matches');
    await db.exec('DELETE FROM game_ids');
    await db.exec('DELETE FROM games_master');
    // Clear audit trail tables too
    await db.exec('DELETE FROM rating_changes');
    await db.exec('DELETE FROM player_deck_assignments');

    logger.info('[THANOS-SNAP] Complete database reset - all player and deck data cleared');
  } catch (error) {
    logger.error('[THANOS-SNAP] Error resetting database:', error);
  }

  // Clean up the backup file from disk since it's now been sent to admins
  try {
    await fs.unlink(backupFile);
    logger.info('[THANOSSNAP] Cleaned up backup file from disk');
  } catch (cleanupError) {
    logger.error('[THANOSSNAP] Error cleaning up backup file:', cleanupError);
  }
}