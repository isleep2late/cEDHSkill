// src/commands/list.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getAllPlayers, getRestrictedPlayers } from '../db/player-utils.js';

export const data = new SlashCommandBuilder()
  .setName('list')
  .setDescription('Show the top N players by rating (including ties at the boundary)')
  .addIntegerOption(opt =>
    opt
      .setName('count')
      .setDescription('How many top players to display (1–50)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(50)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const count = interaction.options.getInteger('count', true);
  const all = await getAllPlayers();

  // …then remove anyone restricted
  const restricted = new Set(await getRestrictedPlayers());
  const filtered = all.filter(p => !restricted.has(p.userId));


  if (all.length === 0) {
    return interaction.reply({
      content: 'No players have been rated yet.',
      ephemeral: true
    });
  }

  // Map and sort by Elo descending
  const ranked = filtered
    .map(p => ({
      id: p.userId,
      elo: convertElo(p.mu, p.sigma)
    }))
    .sort((a, b) => b.elo - a.elo);

  // If more players than requested, include ties at the Nth spot
  let finalList = ranked;
  if (ranked.length > count) {
    const boundaryElo = ranked[count - 1].elo;
    finalList = ranked.filter(p => p.elo >= boundaryElo);
  }

  // Build leaderboard text
  const description = finalList
    .map((p, i) => `${i + 1}. <@${p.id}> — ${p.elo}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Top ${finalList.length} Players`)
    .setDescription(description)
    .setColor('Gold');

  await interaction.reply({ embeds: [embed] });
}

function convertElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}
