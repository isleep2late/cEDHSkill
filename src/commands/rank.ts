import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  TextChannel,
  User
} from 'discord.js';
import { rate, Rating, rating } from 'openskill';
import type { ExtendedClient } from '../bot.js';
import { getOrCreatePlayer, updatePlayerRating, isPlayerRestricted } from '../db/player-utils.js';
import { recordMatch, getRecentMatches, getAdminOptIn } from '../db/match-utils.js';
import { saveMatchSnapshot } from '../utils/snapshot-utils.js';
import { config } from '../config.js';
import crypto from 'crypto';
import { isExempt } from '../utils/suspicion-utils.js';

// Convert mu/sigma into a traditional Elo score
function calculateElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}

// Suspicious‐activity detection, admin games skipped entirely
async function checkForSuspiciousPatterns(
  userId: string,
  submittedByAdmin: boolean
): Promise<string | null> {
  if (submittedByAdmin) return null;
  if (await isExempt(userId)) return null; // 0) Skip anyone who’s been vindicated
  const recent = await getRecentMatches(userId, 50);
  const now = Date.now();

  // Win streak in last 7
  const last7 = recent.slice(0, 7);
  const winSet = new Set<string>();
  for (const m of last7) {
    if (!m.submittedByAdmin && m.status === 'w') {
      winSet.add(m.id);
    }
  }
  if (winSet.size >= 5) {
    return `⚠️ Suspicious activity detected: <@${userId}> has won ${winSet.size} of their last 7 non-admin matches.`;
  }
  return null;
}

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Submit game results for ranking')
  .addStringOption(option =>
    option
      .setName('results')
      .setDescription('Player results string')
      .setRequired(true)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  client: ExtendedClient
): Promise<void> {
  const input = interaction.options.getString('results', true);
  const tokens = input.match(/<@!?\d+>|score:\d+(?:\.\d+)?|team:\w+|[\d.]+|[wld]/gi);
  if (!tokens?.length) {
    await interaction.reply({
      content: '⚠️ Invalid input. Please mention users followed by optional team, score, and placement/result.',
      ephemeral: true
    });
    return;
  }

    // pull out all the mentions…
  const mentionTokens = tokens.filter(t => /^<@!?\d+>$/.test(t));
  const userIds = mentionTokens.map(t => t.replace(/\D/g, ''));
  for (const id of userIds) {
    if (await isPlayerRestricted(id)) {
      await interaction.reply({
        content: `🚫 <@${id}> is restricted from ranked games and cannot be included.`,
        ephemeral: true
      });
      return;    // <-- stops here, no further processing
    }
  }

  type PlayerEntry = {
    userId: string;
    team?: string;
    score?: number;
    status?: string;
    place?: number;
  };

  // Parse players
  const players: PlayerEntry[] = [];
  let current: PlayerEntry | null = null;
  for (const tok of tokens) {
    if (/^<@!?(\d+)>$/.test(tok)) {
      if (current) players.push(current);
      current = { userId: tok.replace(/\D/g, '') };
    } else if (current) {
      if (/^team:/i.test(tok)) current.team = tok.split(':')[1];
      else if (/^score:/i.test(tok)) current.score = parseFloat(tok.split(':')[1]);
      else if (/^[wld]$/i.test(tok)) current.status = tok.toLowerCase();
      else if (/^[\d.]+$/.test(tok)) current.place = parseFloat(tok);
    }
  }
  if (current) players.push(current);

  if (players.length < 2) {
    await interaction.reply({
      content: '❌ You must enter at least two players with results.',
      ephemeral: true
    });
    return;
  }


  // --- CEDH MODE: enforce 3-4 players, only w/l/d, no teams/scores/ranks ---
const numPlayers = players.length;
if (![3, 4].includes(numPlayers)) {
  await interaction.reply({
    content: '❌ Only 3-player or 4-player games are supported in cEDH mode.',
    ephemeral: true
  });
  return;
}

// — Prevent someone from listing the same user twice —
const playerIds = players.map(p => p.userId);
const uniqueIds = new Set(playerIds);
if (uniqueIds.size !== playerIds.length) {
  await interaction.reply({
    content: '❌ Duplicate players detected: please list each player only once.',
    ephemeral: true
  });
  return;
}

// disallow any team labels
if (players.some(p => p.team !== undefined)) {
  await interaction.reply({
    content: '❌ Team labels are not allowed in cEDH mode. Please only use w/l/d results.',
    ephemeral: true
  });
  return;
}

// disallow any numeric scores
if (players.some(p => p.score !== undefined)) {
  await interaction.reply({
    content: '❌ Scores are not allowed in cEDH mode. Please only use w/l/d results.',
    ephemeral: true
  });
  return;
}

// disallow any numeric placements
if (players.some(p => p.place !== undefined)) {
  await interaction.reply({
    content: '❌ Numeric placements are not allowed in cEDH mode. Please only use w/l/d results.',
    ephemeral: true
  });
  return;
}

// ensure each player has exactly w, l, or d
if (players.some(p => !['w', 'l', 'd'].includes(p.status ?? ''))) {
  await interaction.reply({
    content: '❌ Invalid input: each player must have a result of w (win), l (loss), or d (draw).',
    ephemeral: true
  });
  return;
}

const winCount  = players.filter(p => p.status === 'w').length;
const drawCount = players.filter(p => p.status === 'd').length;

// enforce exactly one winner (no draws) OR multi-way draw (no winners)
if (
  winCount > 1 ||
  (winCount === 1 && drawCount > 0) ||
  (winCount === 0 && drawCount < 2)
) {
  await interaction.reply({
    content:
      '❌ Invalid result combination: either exactly one winner (no draws), ' +
      'or a multi-way draw of two or more players (no winners).',
    ephemeral: true
  });
  return;
}
// --- END CEDH MODE ENFORCEMENT ---


  // Admin check
  const isAdmin = config.admins.includes(interaction.user.id);
  const submittedByAdmin = isAdmin;

  // Pre-fetch usernames, ratings, and records
  const userNames: Record<string, string> = {};
  const preRatings: Record<string, Rating> = {};
  const records: Record<string, { wins: number; losses: number; draws: number }> = {};
  for (const p of players) {
    try {
      const u = await client.users.fetch(p.userId);
      userNames[p.userId] = `@${u.username}`;
    } catch {
      userNames[p.userId] = `<@${p.userId}>`;
    }
    const pd = await getOrCreatePlayer(p.userId);
    preRatings[p.userId] = rating({ mu: pd.mu, sigma: pd.sigma });
    records[p.userId] = {
      wins: (pd as any).wins || 0,
      losses: (pd as any).losses || 0,
      draws: (pd as any).draws || 0
    };
  }

  // Initial embed
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Game Results ${isAdmin ? 'Auto Confirmed' : 'Pending Confirmation'}`)
    .setDescription(
      isAdmin
        ? '✅ Results submitted by admin. Ratings have been updated.'
        : 'Please react with 👍 to confirm your participation and result.'
    )
    .addFields(
      players.map(p => {
        const r = preRatings[p.userId];
        const rec = records[p.userId];
        return {
          name: userNames[p.userId] + (p.team ? ` (${p.team})` : ''),
          value:
            `Score: ${p.score ?? p.status ?? '❓'}\n` +
            `Elo: ${calculateElo(r.mu, r.sigma)}\n` +
            `Mu: ${r.mu.toFixed(2)}\n` +
            `Sigma: ${r.sigma.toFixed(2)}\n` +
            `W/L/D: ${rec.wins}/${rec.losses}/${rec.draws}`,
          inline: false
        };
      })
    )
    .setColor(0x00AE86);

  const pinged = players.map(p => `<@${p.userId}>`).join(' ');
  const replyMsg = await interaction.reply({
    content: `📢 Game results submitted.${submittedByAdmin ? '' : ` Waiting for confirmations from: ${pinged}`}`,
    embeds: [embed],
    fetchReply: true
  });

  const matchId = crypto.randomUUID();

  if (submittedByAdmin) {
    // Admin path: exactly same as below but with submittedByAdmin=true
    const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
    const prs = players.map(p => ({
      ...p,
      key: typeof p.score === 'number' ? `score:${p.score}` : `status:${p.status}`
    }));
    const sortCopy = [...prs].sort((a, b) => {
      if (typeof a.score === 'number' && typeof b.score === 'number') {
        return b.score - a.score;
      }
      if (a.status && b.status) {
        return (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
      }
      return 0;
    });
    const ranks: number[] = [];
    let cr = 1;
    for (let i = 0; i < sortCopy.length; i++) {
      if (i > 0 && sortCopy[i].key !== sortCopy[i - 1].key) cr = i + 1;
      ranks[players.findIndex(p => p.userId === sortCopy[i].userId)] = cr;
    }

    const ordered = players.map(p => [preRatings[p.userId]]);
    const newMatrix = rate(ordered, { rank: ranks });
    const allDraw = players.every(p => p.status === 'd');
    const scale = allDraw ? 1 : 1 + (players.length - 2) * 0.05;
    const results: string[] = [];

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const oldR = preRatings[p.userId];
      const newR = newMatrix[i][0];
      newR.mu = 25 + (newR.mu - 25) * scale;
      newR.sigma = newR.sigma / scale;
      const rec = records[p.userId];
      if (p.status === 'w') rec.wins++;
      else if (p.status === 'l') rec.losses++;
      else if (p.status === 'd') rec.draws++;

      await updatePlayerRating(p.userId, newR.mu, newR.sigma, rec.wins, rec.losses, rec.draws);
      await recordMatch(matchId, p.userId, p.status ?? 'd', new Date(), newR.mu, newR.sigma, [], [], p.score, true);

      results.push(
        `${userNames[p.userId]}${p.team ? ` (${p.team})` : ''}\n` +
          `Old Elo: ${calculateElo(oldR.mu, oldR.sigma)} → New Elo: ${calculateElo(newR.mu, newR.sigma)}\n` +
          `Old Mu: ${oldR.mu.toFixed(2)} → New Mu: ${newR.mu.toFixed(2)}\n` +
          `Old Sigma: ${oldR.sigma.toFixed(2)} → New Sigma: ${newR.sigma.toFixed(2)}\n` +
          `W/L/D: ${rec.wins}/${rec.losses}/${rec.draws}`
      );
    }

    await saveMatchSnapshot({
      matchId,
      before: players.map(p => ({
        userId: p.userId,
        mu: preRatings[p.userId].mu,
        sigma: preRatings[p.userId].sigma,
        wins: records[p.userId].wins - (players.find(x => x.userId === p.userId)?.status === 'w' ? 1 : 0),
        losses: records[p.userId].losses - (players.find(x => x.userId === p.userId)?.status === 'l' ? 1 : 0),
        draws: records[p.userId].draws - (players.find(x => x.userId === p.userId)?.status === 'd' ? 1 : 0),
        tag: userNames[p.userId]
      })),
      after: players.map((p, i) => ({
        userId: p.userId,
        mu: newMatrix[i][0].mu,
        sigma: newMatrix[i][0].sigma,
        wins: records[p.userId].wins,
        losses: records[p.userId].losses,
        draws: records[p.userId].draws,
        tag: userNames[p.userId]
      }))
    });

    const resultEmbed = new EmbedBuilder()
      .setTitle('✅ All players have confirmed. Results are now final!')
      .setDescription(results.join('\n\n'))
      .setColor(0x4BB543);

    const chan = replyMsg.channel as TextChannel;
    await chan.send({ embeds: [resultEmbed] });

    for (const p of players.filter(p => p.status === 'w')) {
      const alert = await checkForSuspiciousPatterns(p.userId, true);
      if (!alert) continue;

      
      for (const aid of config.admins) {
          if (!(await getAdminOptIn(aid))) continue;
        try {
          const adminUser = await client.users.fetch(aid);
          await adminUser.send(alert);
        } catch {}
      }
      
    }

  } else {
    // Non-admin: wait for 👍, then inline the same update logic
    const pending = new Set(players.map(p => p.userId));
    if (client.user?.id) pending.delete(client.user.id);
    await replyMsg.react('👍');

    const collector = replyMsg.createReactionCollector({
      filter: (reaction, user) =>
        reaction.emoji.name === '👍' && pending.has(user.id) && !user.bot,
      time: 60 * 60 * 1000
    });

    collector.on('collect', async (_reaction, user) => {
      pending.delete(user.id);
      if (pending.size === 0) {
        collector.stop();

        // inline “admin” logic but mark submittedByAdmin=false
        const statusRank: Record<string, number> = { w: 1, d: 2, l: 3 };
        const prs = players.map(p => ({
          ...p,
          key: typeof p.score === 'number' ? `score:${p.score}` : `status:${p.status}`
        }));
        const sortCopy = [...prs].sort((a, b) => {
          if (typeof a.score === 'number' && typeof b.score === 'number') {
            return b.score - a.score;
          }
          if (a.status && b.status) {
            return (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
          }
          return 0;
        });
        const ranks: number[] = [];
        let cr2 = 1;
        for (let i = 0; i < sortCopy.length; i++) {
          if (i > 0 && sortCopy[i].key !== sortCopy[i - 1].key) cr2 = i + 1;
          ranks[players.findIndex(p => p.userId === sortCopy[i].userId)] = cr2;
        }

        const ordered2 = players.map(p => [preRatings[p.userId]]);
        const newMatrix2 = rate(ordered2, { rank: ranks });
        const allDraw2 = players.every(p => p.status === 'd');
        const scale2 = allDraw2 ? 1 : 1 + (players.length - 2) * 0.05;
        const results2: string[] = [];

        for (let i = 0; i < players.length; i++) {
          const p = players[i];
          const oldR = preRatings[p.userId];
          const newR = newMatrix2[i][0];
          newR.mu = 25 + (newR.mu - 25) * scale2;
          newR.sigma = newR.sigma / scale2;
          const rec = records[p.userId];
          if (p.status === 'w') rec.wins++;
          else if (p.status === 'l') rec.losses++;
          else if (p.status === 'd') rec.draws++;

          await updatePlayerRating(p.userId, newR.mu, newR.sigma, rec.wins, rec.losses, rec.draws);
          await recordMatch(matchId, p.userId, p.status ?? 'd', new Date(), newR.mu, newR.sigma, [], [], p.score, false);

          results2.push(
            `${userNames[p.userId]}${p.team ? ` (${p.team})` : ''}\n` +
              `Old Elo: ${calculateElo(oldR.mu, oldR.sigma)} → New Elo: ${calculateElo(newR.mu, newR.sigma)}\n` +
              `Old Mu: ${oldR.mu.toFixed(2)} → New Mu: ${newR.mu.toFixed(2)}\n` +
              `Old Sigma: ${oldR.sigma.toFixed(2)} → New Sigma: ${newR.sigma.toFixed(2)}\n` +
              `W/L/D: ${rec.wins}/${rec.losses}/${rec.draws}`
          );
        }

        await saveMatchSnapshot({
          matchId,
          before: players.map(p => ({
            userId: p.userId,
            mu: preRatings[p.userId].mu,
            sigma: preRatings[p.userId].sigma,
            wins: records[p.userId].wins - (players.find(x => x.userId === p.userId)?.status === 'w' ? 1 : 0),
            losses: records[p.userId].losses - (players.find(x => x.userId === p.userId)?.status === 'l' ? 1 : 0),
            draws: records[p.userId].draws - (players.find(x => x.userId === p.userId)?.status === 'd' ? 1 : 0),
            tag: userNames[p.userId]
          })),
          after: players.map((p, i) => ({
            userId: p.userId,
            mu: newMatrix2[i][0].mu,
            sigma: newMatrix2[i][0].sigma,
            wins: records[p.userId].wins,
            losses: records[p.userId].losses,
            draws: records[p.userId].draws,
            tag: userNames[p.userId]
          }))
        });

        const resultEmbed2 = new EmbedBuilder()
          .setTitle('✅ All players have confirmed. Results are now final!')
          .setDescription(results2.join('\n\n'))
          .setColor(0x4BB543);

        const chan2 = replyMsg.channel as TextChannel;
        await chan2.send({ embeds: [resultEmbed2] });

        for (const p of players.filter(p => p.status === 'w')) {
      const alert = await checkForSuspiciousPatterns(p.userId, false);
      if (!alert) continue;

      
      for (const aid of config.admins) {
          if (!(await getAdminOptIn(aid))) continue;
        try {
          const adminUser = await client.users.fetch(aid);
          await adminUser.send(alert);
        } catch {}
      }
      
    }
      }
    });
  }
}
