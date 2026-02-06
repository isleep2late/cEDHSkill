import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { unrestrictPlayer } from '../db/player-utils.js';
import { exemptPlayer } from '../utils/suspicion-utils.js';
import { config } from '../config.js';  

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('vindicate')
  .setDescription('Unrestrict a user and clear them of any suspicion')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('The user to allow back into ranked play and clear suspicion')
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Defer immediately to prevent timeout
  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser('user', true);

  if (!hasModAccess(interaction.user.id)) {
    await interaction.editReply({
      content: '❌ You are not a bot admin/mod.'
    });
    return;
  }

  try {
    await unrestrictPlayer(user.id);
    await exemptPlayer(user.id);

    await interaction.editReply({
      content: `✅ <@${user.id}> is now unrestricted and cleared of suspicion.`
    });
  } catch (error) {
    console.error('Error in vindicate command:', error);
    await interaction.editReply({
      content: '❌ An error occurred while vindicating the player.'
    });
  }
}
