import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import type { ExtendedClient } from '../bot.js';
import { config } from '../config.js';
import { cleanupUnconfirmedGame } from './rank.js';

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('snap')
  .setDescription('Admin/Mod: delete all unconfirmed game messages (limbo) - includes both player and deck-only games');

export async function execute(
  interaction: ChatInputCommandInteraction,
  client: ExtendedClient
): Promise<void> {
  if (!hasModAccess(interaction.user.id)) {
    await interaction.reply({
      content: '⚠️ You are not a bot admin.',
      ephemeral: true
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    await interaction.reply({
      content: '⚠️ /snap can only be used in text channels.',
      ephemeral: true
    });
    return;
  }

  // Defer reply since deleting many messages could take time
  await interaction.deferReply();

  const limboEntries = Array.from(client.limboGames.entries());
  let deleted = 0;
  let failed = 0;
  let dbCleaned = 0;

  for (const [msgId, limboData] of limboEntries) {
    // Clean up Discord message
    try {
      const msg = await channel.messages.fetch(msgId);
      await msg.delete();
      deleted++;
    } catch (error) {
      // Cannot fetch or delete: ignore and count as failed
      failed++;
      console.log(`[SNAP] Failed to delete message ${msgId}:`, error);
    }

    // Clean up database records for the unconfirmed game
    try {
      await cleanupUnconfirmedGame(limboData.gameId);
      dbCleaned++;
    } catch (error) {
      console.error(`[SNAP] Failed to clean up game ${limboData.gameId} from database:`, error);
    }
  }

  // Clear all limbo games regardless of deletion success
  client.limboGames.clear();

  let responseMessage = `🧹 Cleared ${deleted} limbo game message(s) and removed ${dbCleaned} unconfirmed game(s) from the database.`;

  if (failed > 0) {
    responseMessage += ` (${failed} message(s) were already deleted or inaccessible)`;
  }

  if (deleted === 0 && failed === 0) {
    responseMessage = '📭 No limbo games found to clear.';
  }

  await interaction.editReply({
    content: responseMessage,
  });
}
