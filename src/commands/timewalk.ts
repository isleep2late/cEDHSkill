import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder
} from 'discord.js';
import { config } from '../config.js';
import { applyRatingDecay, getMinDaysForNextDecay, addTimewalkDays, getTimewalkDays, saveTimewalkEvent } from '../bot.js';
import { logger } from '../utils/logger.js';

/**
 * /timewalk - Admin-only command for testing the decay system
 *
 * This command simulates time passing for decay purposes.
 * - Without parameters: simulates minimum days needed for next decay
 * - With 'days' parameter: simulates that exact number of days
 *
 * Cumulative tracking: Each timewalk adds to a virtual "days passed" counter,
 * so subsequent timewalks only need to simulate 1 day to trigger the next decay.
 *
 * IMPORTANT: This is for admin testing only, NOT for regular users or moderators.
 */

// Maximum days allowed for timewalk (security limit)
const MAX_TIMEWALK_DAYS = 90;

function isAdmin(userId: string): boolean {
  return config.admins.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('timewalk')
  .setDescription('Admin only: Simulate time passing for decay testing')
  .addIntegerOption(option =>
    option
      .setName('days')
      .setDescription(`Number of days to simulate (1-${MAX_TIMEWALK_DAYS}, default: minimum needed for next decay)`)
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(MAX_TIMEWALK_DAYS)
  );

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
    const gracePeriod = config.decayStartDays || 6;
    const cumulativeBefore = getTimewalkDays();

    // Get explicit days parameter, or calculate minimum needed for next decay
    const explicitDays = interaction.options.getInteger('days');

    // Server-side validation (backup security check)
    if (explicitDays !== null && (explicitDays < 1 || explicitDays > MAX_TIMEWALK_DAYS)) {
      await interaction.editReply({
        content: `Days must be between 1 and ${MAX_TIMEWALK_DAYS}.`
      });
      return;
    }

    const simulatedDays = explicitDays ?? await getMinDaysForNextDecay();

    logger.info(`[TIMEWALK] Admin ${userId} triggered manual decay cycle (simulating +${simulatedDays} days, cumulative before: ${cumulativeBefore})`);

    // Save the timewalk event to the database for persistence across recalculations
    const timewalkEventId = await saveTimewalkEvent(simulatedDays, userId);

    // Execute the decay process with timewalk trigger, admin ID, simulated days, and event ID
    const decayedCount = await applyRatingDecay('timewalk', userId, simulatedDays, false, timewalkEventId);

    // Add to cumulative counter AFTER successful decay
    addTimewalkDays(simulatedDays);
    const cumulativeAfter = getTimewalkDays();

    const embed = new EmbedBuilder()
      .setTitle('Time Walk')
      .setDescription(
        `Simulating **+${simulatedDays} day${simulatedDays > 1 ? 's' : ''}** passing...\n\n` +
        `**Players affected:** ${decayedCount}\n` +
        `**Virtual time:** Day ${cumulativeAfter} (was ${cumulativeBefore})\n\n` +
        (decayedCount > 0
          ? `Use \`/undo\` to reverse this decay if needed.`
          : `No players met the decay criteria.\n` +
            `(Grace period: ${gracePeriod} day${gracePeriod > 1 ? 's' : ''})`)
      )
      .setColor(0x9B59B6) // Purple for the "time magic" theme
      .setFooter({ text: 'Virtual time is preserved across recalculations' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    logger.error('[TIMEWALK] Error during manual decay:', error);
    await interaction.editReply({
      content: 'An error occurred while executing the decay cycle. Check the logs for details.'
    });
  }
}
