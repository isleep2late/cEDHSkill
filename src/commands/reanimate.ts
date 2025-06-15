// src/commands/reanimate.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { removeExemption } from '../utils/suspicion-utils.js';
import { config } from '../config.js';  

export const data = new SlashCommandBuilder()
  .setName('reanimate')
  .setDescription('Allow a previously exempted player to be flagged again for suspicious activity')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('The player to remove from the exemption list')
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

  await removeExemption(user.id);
  await interaction.reply({
    content: `✅ <@${user.id}> can now be flagged for suspicious activity again.`,
    ephemeral: true
  });
}