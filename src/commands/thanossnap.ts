// src/commands/thanos-snap.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAllPlayers,
  getRestrictedPlayers,
} from '../db/player-utils.js';
import { config } from '../config.js';

function convertElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}

export const data = new SlashCommandBuilder()
  .setName('thanos-snap')
  .setDescription('Admin: end the season, show top 50, and reset rankings')

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {

if (!config.admins.includes(interaction.user.id)) {
    await interaction.reply({
      content: '❌ You are not a bot admin.',
      ephemeral: true
    });
    return;
  }


  // 1) Backup current DB file
  const dbFile = path.resolve('data', 'database.sqlite');
  const backupFile = path.resolve(
    'data',
    `backup_${Date.now()}.sqlite`
  );
  try {
    await fs.copyFile(dbFile, backupFile);
  } catch (err) {
    console.error('Backup failed:', err);
  }

  // 2) Build and send leaderboard
  const all = await getAllPlayers();
  const restricted = new Set(await getRestrictedPlayers());
  const filtered = all.filter(p => !restricted.has(p.userId));
  const ranked = filtered
    .map(p => ({ id: p.userId, elo: convertElo(p.mu, p.sigma) }))
    .sort((a, b) => b.elo - a.elo);
  const top = ranked.slice(0, 50);
  const boundaryElo = top.length === 50 ? top[49].elo : -Infinity;
  const finalList = ranked.filter(p => p.elo >= boundaryElo);
  const desc = finalList
    .map((p, i) => `${i + 1}. <@${p.id}> — ${p.elo}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🌌 Season Over: Top Players')
    .setDescription(desc)
    .setColor('DarkPurple');

  await interaction.reply({ embeds: [embed] });

  // 3) Reset tables: players, matches, restricted, suspicionExempt
  import('../db/init.js').then(async ({ dbPromise }) => {
    const db = await dbPromise;
    await db.exec('DELETE FROM players;');
    await db.exec('DELETE FROM matches;');
    await db.exec('DELETE FROM restricted;');
    await db.exec('DELETE FROM suspicionExempt;');
  });
}
