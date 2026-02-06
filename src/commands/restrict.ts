import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { restrictPlayer } from '../db/player-utils.js';
import { config } from '../config.js'; 

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('restrict')
  .setDescription('Restrict a user from participating in ranked games')
  .addUserOption(option =>
    option.setName('user')
      .setDescription('The user to restrict')
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Defer immediately to prevent timeout
  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser('user', true);

  if (!hasModAccess(interaction.user.id)) {
    await interaction.editReply({
      content: 'You are not a bot admin/mod.'
    });
    return;
  }

  try {
    await restrictPlayer(user.id);
    await interaction.editReply({
      content: `<@${user.id}> has been restricted from ranked games.`
    });
  } catch (error) {
    console.error('Error in restrict command:', error);
    await interaction.editReply({
      content: '❌ An error occurred while restricting the player.'
    });
  }
}
