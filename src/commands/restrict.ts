import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits
} from 'discord.js';
import { restrictPlayer } from '../db/match-utils.js';
import { config } from '../config.js';  

export const data = new SlashCommandBuilder()
  .setName('restrict')
  .setDescription('Restrict a user from participating in ranked games')
  .addUserOption(option =>
    option.setName('user')
      .setDescription('The user to restrict')
      .setRequired(true)
  )

export async function execute(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser('user', true);

if (!config.admins.includes(interaction.user.id)) {
    await interaction.reply({
      content: '❌ You are not a bot admin.',
      ephemeral: true
    });
    return;
  }

  await restrictPlayer(user.id);
  await interaction.reply({ content: `🚫 <@${user.id}> has been restricted from ranked games.`, ephemeral: true });
}
