import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { removeExemption } from '../utils/suspicion-utils.js';
import { config } from '../config.js';

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('reanimate')
  .setDescription('Allow a previously exempted player to be flagged again for suspicious activity')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('The player to remove from the exemption list')
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Defer immediately to prevent timeout
  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser('user', true);

  if (!hasModAccess(interaction.user.id)) {
    await interaction.editReply({
      content: '❌ You are not a bot admin.'
    });
    return;
  }

  try {
    await removeExemption(user.id);
    await interaction.editReply({
      content: `✅ <@${user.id}> can now be flagged for suspicious activity again.`
    });
  } catch (error) {
    console.error('Error in reanimate command:', error);
    await interaction.editReply({
      content: '❌ An error occurred while processing this command.'
    });
  }
}
