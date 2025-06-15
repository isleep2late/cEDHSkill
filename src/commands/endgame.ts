// src/commands/endgame.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('endgame')
  .setDescription('Admin: restore the pre–ThanosSnap season backup')

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {

if (!config.admins.includes(interaction.user.id)) {
    await interaction.reply({
      content: '❌ You are not a bot admin.',
      ephemeral: true
    });
    return;
  }

  const dataDir = path.resolve('data');
  const files = await fs.readdir(dataDir);
  const backups = files
    .filter(f => f.startsWith('backup_') && f.endsWith('.sqlite'))
    .sort()
    .reverse();

  if (!backups.length) {
    await interaction.reply({
      content: '❌ No backup found to restore.',
      ephemeral: true,
    });
    return;
  }
  const latest = backups[0];
  const src = path.join(dataDir, latest);
  const dest = path.join(dataDir, 'database.sqlite');

  try {
    await fs.copyFile(src, dest);
    await interaction.reply({
      content: '🕹️ Avengers, assemble! The last ranked season has been restored.',
    });
  } catch (err) {
    console.error('Restore failed:', err);
    await interaction.reply({ content: '❌ Failed to restore backup.', ephemeral: true });
  }
}
