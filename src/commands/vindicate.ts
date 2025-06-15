// src/commands/vindicate.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits
} from 'discord.js';
// Use unrestrictPlayer to lift ranked ban
import { unrestrictPlayer } from '../db/player-utils.js';
// Use exemptPlayer to clear suspicion
import { exemptPlayer }    from '../utils/suspicion-utils.js';
import { config } from '../config.js';  

export const data = new SlashCommandBuilder()
  .setName('vindicate')
  .setDescription('Unrestrict a user and clear them of any suspicion')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('The user to allow back into ranked play and clear suspicion')
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

  // 1) Lift ranked restriction
  await unrestrictPlayer(user.id);
  // 2) Clear any future suspicion alerts
  await exemptPlayer(user.id);

  await interaction.reply({
    content: `✅ <@${user.id}> is now unrestricted and cleared of suspicion.`,
    ephemeral: true
  });
}
