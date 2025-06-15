// src/commands/redo.ts

import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { redoLastMatch } from '../utils/snapshot-utils.js';
import { getOrCreatePlayer, updatePlayerRating } from '../db/player-utils.js';
import { calculateElo } from '../utils/rating-utils.js';

export const data = new SlashCommandBuilder()
  .setName('redo')
  .setDescription('Admin: reapply the most recently undone match and update ratings');

export async function execute(interaction: ChatInputCommandInteraction) {
  // Permission check
  if (!config.admins.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    return;
  }

  // Pop the last undone snapshot
  const snapshot = redoLastMatch();
  if (!snapshot || snapshot.after.length === 0) {
    await interaction.reply({ content: '⚠️ No match to redo.', ephemeral: true });
    return;
  }

  // Build result embed
  const embed = new EmbedBuilder()
    .setTitle('↪️ Redo Successful')
    .setDescription('Reapplied the most recently undone match and updated ratings.')
    .setColor(0x00aaff);

    // outside your loop, or imported from a util:
   function calculateElo(mu: number, sigma: number): number {
     const baseElo = 1000;
     const eloFromMu = (mu - 25) * 12;
     const sigmaPenalty = (sigma - 8.333) * 4;
     return Math.round(baseElo + eloFromMu - sigmaPenalty);
    }

  // For each player, show old vs reapplied stats
  for (const p of snapshot.after) {

    const previous = await getOrCreatePlayer(p.userId);
    const oldElo = calculateElo(previous.mu, previous.sigma);

    // Reapply stats
    await updatePlayerRating(p.userId, p.mu, p.sigma, p.wins, p.losses, p.draws);
    const newElo = calculateElo(p.mu, p.sigma);

    embed.addFields({
      name: p.tag,
      value:
        `Old: Elo=${oldElo}, μ=${previous.mu.toFixed(2)}, σ=${previous.sigma.toFixed(2)}, ` +
        `W/L/D: ${previous.wins}/${previous.losses}/${previous.draws}\n` +
        `Reapplied: Elo=${newElo}, μ=${p.mu.toFixed(2)}, σ=${p.sigma.toFixed(2)}, ` +
        `W/L/D: ${p.wins}/${p.losses}/${p.draws}`,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed] });
}
