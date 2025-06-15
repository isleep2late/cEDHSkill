// src/commands/playerinfo.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getOrCreatePlayer, getAllPlayers } from '../db/player-utils.js';

export const data = new SlashCommandBuilder()
  .setName('playerinfo')
  .setDescription('Display rating info for a player')
  .addUserOption(opt =>
    opt
      .setName('user')
      .setDescription('The player to look up')
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser('user', true);

  // Fetch (or create) the player record
  const player = await getOrCreatePlayer(user.id);

  if (!player) {
    return interaction.reply({
      content: `No rating data found for ${user.tag}.`,
      ephemeral: true
    });
  }

  const { mu, sigma, wins, losses, draws } = player;
  const elo = convertElo(mu, sigma);

  // Determine current rank among all players
  const all = await getAllPlayers();
  const ranked = all
    .map(p => ({ id: p.userId, elo: convertElo(p.mu, p.sigma) }))
    .sort((a, b) => b.elo - a.elo);
  const position = ranked.findIndex(p => p.id === user.id) + 1;

  const embed = new EmbedBuilder()
    .setTitle(`${user.username}’s Rating`)
    .addFields(
      { name: 'Elo',   value: elo.toString(),                  inline: true },
      { name: 'Mu',    value: mu.toFixed(2),                   inline: true },
      { name: 'Sigma', value: sigma.toFixed(2),                inline: true },
      { name: 'Rank',  value: `#${position}`,                  inline: true },
      { name: 'W/L/D', value: `${wins}/${losses}/${draws}`,    inline: true }
    )
    .setColor('Blue');

  await interaction.reply({ embeds: [embed] });
}

function convertElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}
