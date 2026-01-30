import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder
} from 'discord.js';
import { config } from '../config.js';
import { applyRatingDecay } from '../bot.js';

/**
 * /timewalk - Admin-only command for testing the decay system
 *
 * This command manually triggers the rating decay process,
 * effectively "fast-forwarding" time by 24 hours for decay purposes.
 *
 * IMPORTANT: This is for admin testing only, NOT for regular users or moderators.
 */

function isAdmin(userId: string): boolean {
  return config.admins.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('timewalk')
  .setDescription('Admin only: Fast-forward to the next decay cycle (for testing)');

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;

  // STRICT: Admin-only, NOT moderators
  if (!isAdmin(userId)) {
    await interaction.reply({
      content: 'This command is restricted to administrators only.',
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply();

  try {
    console.log(`[TIMEWALK] Admin ${userId} triggered manual decay cycle`);

    // Execute the decay process
    await applyRatingDecay();

    const embed = new EmbedBuilder()
      .setTitle('Time Walk')
      .setDescription(
        'Successfully executed manual decay cycle.\n\n' +
        'The rating decay process has been triggered as if midnight had passed.\n' +
        'Check the console logs for details on which players (if any) were affected.'
      )
      .setColor(0x9B59B6) // Purple for the "time magic" theme
      .setFooter({ text: 'Note: This does not affect player lastPlayed timestamps' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[TIMEWALK] Error during manual decay:', error);
    await interaction.editReply({
      content: 'An error occurred while executing the decay cycle. Check the logs for details.'
    });
  }
}
