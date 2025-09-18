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
  const user = interaction.options.getUser('user', true);

  if (!hasModAccess(interaction.user.id)) {
    await interaction.reply({
      content: '❌ You are not a bot admin/mod.',
      ephemeral: true
    });
    return;
  }

  await unrestrictPlayer(user.id);
  await exemptPlayer(user.id);

  await interaction.reply({
    content: `✅ <@${user.id}> is now unrestricted and cleared of suspicion.`,
    ephemeral: true
  });
}
