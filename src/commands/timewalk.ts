import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder
} from 'discord.js';
import { config } from '../config.js';
import { applyRatingDecay, getMinDaysForNextDecay } from '../bot.js';

/**
 * /timewalk - Admin-only command for testing the decay system
 *
 * This command simulates time passing for decay purposes.
 * - Without parameters: simulates minimum days needed for next decay
 * - With 'days' parameter: simulates that exact number of days
 *
 * IMPORTANT: This is for admin testing only, NOT for regular users or moderators.
 */

function isAdmin(userId: string): boolean {
  return config.admins.includes(userId);
}

export const data = new SlashCommandBuilder()
  .setName('timewalk')
  .setDescription('Admin only: Simulate time passing for decay testing')
  .addIntegerOption(option =>
    option
      .setName('days')
      .setDescription('Number of days to simulate (default: minimum needed for next decay)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(365)
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

    // Get explicit days parameter, or calculate minimum needed for next decay
    const explicitDays = interaction.options.getInteger('days');
    const simulatedDays = explicitDays ?? await getMinDaysForNextDecay();

    console.log(`[TIMEWALK] Admin ${userId} triggered manual decay cycle (simulating +${simulatedDays} days)`);

    // Execute the decay process with timewalk trigger, admin ID, and simulated days
    const decayedCount = await applyRatingDecay('timewalk', userId, simulatedDays);

    const embed = new EmbedBuilder()
      .setTitle('Time Walk')
      .setDescription(
        `Simulating **+${simulatedDays} day${simulatedDays > 1 ? 's' : ''}** passing...\n\n` +
        `**Players affected:** ${decayedCount}\n\n` +
        (decayedCount > 0
          ? `Use \`/undo\` to reverse this decay if needed.`
          : `No players met the decay criteria.\n` +
            `(Grace period: ${gracePeriod} day${gracePeriod > 1 ? 's' : ''}, simulated: ${simulatedDays} day${simulatedDays > 1 ? 's' : ''})`)
      )
      .setColor(0x9B59B6) // Purple for the "time magic" theme
      .setFooter({ text: 'Note: This simulates time for decay checks only - lastPlayed timestamps are unchanged' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[TIMEWALK] Error during manual decay:', error);
    await interaction.editReply({
      content: 'An error occurred while executing the decay cycle. Check the logs for details.'
    });
  }
}
