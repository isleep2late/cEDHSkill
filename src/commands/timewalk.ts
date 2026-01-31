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

    // Execute the decay process with timewalk trigger and admin ID
    const decayedCount = await applyRatingDecay('timewalk', userId);

    const embed = new EmbedBuilder()
      .setTitle('Time Walk')
      .setDescription(
        `Successfully executed manual decay cycle.\n\n` +
        `**Players affected:** ${decayedCount}\n\n` +
        (decayedCount > 0
          ? `Use \`/undo\` to reverse this decay if needed.`
          : `No players met the decay criteria this cycle.`)
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
