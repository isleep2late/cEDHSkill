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
  const user = interaction.options.getUser('user', true);

  if (!hasModAccess(interaction.user.id)) {
    await interaction.reply({
      content: 'You are not a bot admin/mod.',
      ephemeral: true
    });
    return;
  }

  restrictPlayer(user.id);
  await interaction.reply({ 
    content: `<@${user.id}> has been restricted from ranked games.`, 
    ephemeral: true 
  });
}
