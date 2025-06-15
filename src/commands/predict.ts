// src/commands/predict.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getOrCreatePlayer } from '../db/player-utils.js';

export const data = new SlashCommandBuilder()
  .setName('predict')
  .setDescription('Predict win chances for players or teams')
  .addStringOption(opt =>
    opt
      .setName('input')
      .setDescription('Mentions with optional Team:Label (e.g. @user Team:Blue)')
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const input = interaction.options.getString('input', true).trim();
  const regex = /<@!?(\d+)>(?:\s*Team:([^\s]+))?/g;
  const matches = Array.from(input.matchAll(regex));

  if (matches.length < 2) {
    return interaction.reply({
      content: 'Please mention at least **two** players to predict.',
      ephemeral: true
    });
  }

  const players = matches.map(m => ({ id: m[1], team: m[2] ?? null }));
  const isTeamMode = players.every(p => p.team !== null);

  const withElo = await Promise.all(
    players.map(async p => {
      const rec = await getOrCreatePlayer(p.id);
      const elo = convertElo(rec.mu, rec.sigma);
      return { ...p, elo };
    })
  );

  const embed = new EmbedBuilder().setColor('Purple');
  let description: string;

  if (isTeamMode) {
    const teamMap = new Map<string, number>();
    for (const p of withElo) {
      teamMap.set(p.team!, (teamMap.get(p.team!) ?? 0) + p.elo);
    }
    const teams = Array.from(teamMap.entries()).map(([team, elo]) => ({ team, elo }));
    const total = teams.reduce((sum, t) => sum + t.elo, 0);
    const results = teams
      .map(t => ({ team: t.team, pct: Math.round((t.elo / total) * 100) }))
      .sort((a, b) => b.pct - a.pct);

    embed.setTitle('🏷️ Team Win Probability');
    description = results.map(r => `**${r.team}**: ${r.pct}%`).join('\n');
  } else {
    const total = withElo.reduce((sum, p) => sum + p.elo, 0);
    const results = withElo
      .map(p => ({ mention: `<@${p.id}>`, pct: Math.round((p.elo / total) * 100) }))
      .sort((a, b) => b.pct - a.pct);

    embed.setTitle('🤖 Win Probability');
    description = results.map(r => `${r.mention}: ${r.pct}%`).join('\n');
  }

  embed.setDescription(description);
  await interaction.reply({ embeds: [embed] });
}

function convertElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}
