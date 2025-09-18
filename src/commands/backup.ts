import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder
} from 'discord.js';
import type { ExtendedClient } from '../bot.js';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('backup')
  .setDescription('Admin/Mod: Download a backup copy of the database file');

export async function execute(
  interaction: ChatInputCommandInteraction,
  client: ExtendedClient
): Promise<void> {
  // Check if user is admin
  if (!hasModAccess(interaction.user.id)) {
    await interaction.reply({
      content: '⚠️ You are not a bot admin.',
      ephemeral: true
    });
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });

    // Path to the database file
    const dbPath = path.join(process.cwd(), 'data', 'cEDHSkill.db');
    
    // Check if database file exists
    if (!fs.existsSync(dbPath)) {
      await interaction.editReply({
        content: '⚠️ Database file not found. Make sure the bot has been initialized properly.'
      });
      return;
    }

    // Get database file stats
    const stats = fs.statSync(dbPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    // Create timestamp for backup filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T');
    const dateStr = timestamp[0]; // YYYY-MM-DD
    const timeStr = timestamp[1].split('.')[0]; // HH-MM-SS
    const baseFilename = `cEDHSkill-backup-${dateStr}_${timeStr}`;

    // Split database into parts if needed
    const files = await splitDatabaseIntoFiles(dbPath, baseFilename);

    // Send via DM to admin
    const adminUser = await client.users.fetch(interaction.user.id);
    
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
        messageContent = `🗄️ **Database Backup**\n\n`;
        if (files.length > 1) {
          messageContent += `Database split into ${files.length} parts due to size (${totalBatches} messages)\n`;
          messageContent += `**Original Size**: ${fileSizeMB}MB\n\n`;
          messageContent += `**RECONSTRUCTION INSTRUCTIONS:**\n`;
          messageContent += `1. Download all ${files.length} parts\n`;
          messageContent += `2. Place them in the same folder\n`;
          messageContent += `3. Use the reconstruction script below:\n\n`;
          messageContent += `**Windows (Command Prompt):**\n`;
          messageContent += `\`\`\`\ncopy /b "${baseFilename}_part*.db" "${baseFilename}.db"\n\`\`\`\n\n`;
          messageContent += `**Linux/Mac (Terminal):**\n`;
          messageContent += `\`\`\`\ncat "${baseFilename}_part"*.db > "${baseFilename}.db"\n\`\`\`\n\n`;
          messageContent += `**Alternative - Node.js script:**\n`;
          messageContent += `Save as \`reconstruct.js\` and run with \`node reconstruct.js\`:\n`;
          messageContent += `\`\`\`js\nconst fs = require('fs');\nconst files = [];\nfor(let i=1; i<=${files.length}; i++) files.push('${baseFilename}_part'+i+'.db');\nconst output = fs.createWriteStream('${baseFilename}.db');\nfiles.forEach(f => output.write(fs.readFileSync(f))); output.end();\nconsole.log('Reconstruction complete!');\n\`\`\`\n\n`;
        } else {
          messageContent += `**Size**: ${fileSizeMB}MB\n`;
        }
        messageContent += `**Created**: ${new Date().toLocaleString()}\n\n`;
        
        if (totalBatches > 1) {
          messageContent += `**Message ${batchNumber}/${totalBatches}**\n`;
        }
        
        messageContent += `Files in this message:\n${batch.map(f => `• ${f.filename}`).join('\n')}`;
      } else {
        messageContent = `**Message ${batchNumber}/${totalBatches}** - Database Backup (continued)\n\n`;
        messageContent += `Files in this message:\n${batch.map(f => `• ${f.filename}`).join('\n')}`;
      }

      await adminUser.send({
        content: messageContent,
        files: attachments
      });
    }

    let replyMessage = `✅ Database backup sent to your DMs!\n\n`;
    replyMessage += `**Backup Details:**\n`;
    replyMessage += `• Original Size: ${fileSizeMB}MB\n`;
    replyMessage += `• Files: ${files.length} part${files.length > 1 ? 's' : ''}\n`;
    replyMessage += `• Created: ${new Date().toLocaleString()}\n\n`;
    
    if (files.length > 1) {
      replyMessage += `📂 Database was split into ${files.length} parts due to Discord size limits.\n`;
      replyMessage += `Check your DMs for reconstruction instructions.`;
    } else {
      replyMessage += `Check your direct messages to download the backup file.`;
    }

    await interaction.editReply({
      content: replyMessage
    });

  } catch (dmError) {
    console.error('Failed to send DM backup:', dmError);
    
    // If DM fails, offer alternative
    await interaction.editReply({
      content: `⚠️ Couldn't send backup via DM (you may have DMs disabled).\n\n` +
               `**Alternative options:**\n` +
               `• Enable DMs from server members and try again\n` +
               `• Check your server for a backup channel\n` +
               `• Contact bot administrator for manual backup\n\n` +
               `**Backup would have been:**\n` +
               `• Size: ${fs.statSync(path.join(process.cwd(), 'data', 'cEDHSkill.db')).size / (1024 * 1024)}MB`
    });
  }
}

// Helper function to split database file into multiple parts
async function splitDatabaseIntoFiles(dbPath: string, baseFilename: string): Promise<Array<{buffer: Buffer, filename: string}>> {
  const maxSize = 9 * 1024 * 1024; // 9MB limit to be safe
  const dbBuffer = fs.readFileSync(dbPath);
  
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