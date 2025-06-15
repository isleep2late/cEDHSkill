// src/commands/snap.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import type { ExtendedClient } from '../bot.js';
import { config } from '../config.js';  

export const data = new SlashCommandBuilder()
  .setName('snap')
  .setDescription('Admin: delete all unconfirmed game messages (limbo)')

export async function execute(
  interaction: ChatInputCommandInteraction,
  client: ExtendedClient
): Promise<void> {

if (!config.admins.includes(interaction.user.id)) {
    await interaction.reply({
      content: '❌ You are not a bot admin.',
      ephemeral: true
    });
    return;
  }

  // Assume limboGames maps messageId → Set of pending userIds
  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    await interaction.reply({ content: '❌ /snap can only be used in text channels.', ephemeral: true });
    return;
  }

  const limboIds = Array.from(client.limboGames.keys());
  let deleted = 0;
  for (const msgId of limboIds) {
    try {
      const msg = await channel.messages.fetch(msgId);
      await msg.delete();
      deleted++;
    } catch {
      // cannot fetch or delete: ignore
    }
  }
  client.limboGames.clear();

  await interaction.reply({
    content: `🧹 Cleared ${deleted} limbo game message(s).`,
  });
}
