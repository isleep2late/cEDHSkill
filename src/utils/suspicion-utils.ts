import { getRecentMatches } from '../db/match-utils.js';
import { dbPromise } from '../db/init.js';

(async () => {
  const db = await dbPromise;
  await db.run(`
    CREATE TABLE IF NOT EXISTS suspicionExempt (
      userId TEXT PRIMARY KEY
    );
  `);
})();

/**
 * Mark a player so they will no longer be flagged.
 */
export async function exemptPlayer(userId: string): Promise<void> {
  const db = await dbPromise;
  await db.run(
    `INSERT OR IGNORE INTO suspicionExempt (userId) VALUES (?);`,
    userId
  );
}

/**
 * Remove exemption (if you ever want to let them be flagged again).
 */
export async function removeExemption(userId: string): Promise<void> {
  const db = await dbPromise;
  await db.run(
    `DELETE FROM suspicionExempt WHERE userId = ?;`,
    userId
  );
}

/**
 * Returns true if this player should be skipped by all suspicious checks.
 */
export async function isExempt(userId: string): Promise<boolean> {
  const db = await dbPromise;
  const row = await db.get<{ userId: string }>(
    `SELECT userId FROM suspicionExempt WHERE userId = ?;`,
    userId
  );
  return !!row;
}

export async function checkForSuspiciousPatterns(userId: string, submittedByAdmin: boolean): Promise<string | null> {
  if (submittedByAdmin) return null;

  const recent = await getRecentMatches(userId, 50);
  const now = Date.now();

  // Criteria 1: Same player wins 5 out of last 7 matches
  const last7 = recent.slice(0, 7);
  const winSet = new Set<string>();
  for (const match of last7) {
    if (!match.submittedByAdmin && match.status === 'w') {
      winSet.add(match.id);
    }
  }
  if (winSet.size >= 5) {
    return `⚠️ Suspicious activity detected: <@${userId}> has won 5 of their last 7 non-admin matches.`;
  }

  // Criteria 2: Any user submits 6 matches in 30 min, same winner in 5/6
  const submitterMap: Record<string, { timestamp: number; winnerId: string }[]> = {};
  for (const match of recent) {
    if (!match.submittedByAdmin) {
      const time = new Date(match.timestamp).getTime();
      if (!submitterMap[match.userId]) submitterMap[match.userId] = [];
      submitterMap[match.userId].push({ timestamp: time, winnerId: match.userId });
    }
  }
  for (const [submitter, entries] of Object.entries(submitterMap)) {
    const windowEntries = entries.filter(e => now - e.timestamp <= 30 * 60 * 1000);
    if (windowEntries.length >= 6) {
      const countByWinner: Record<string, number> = {};
      for (const e of windowEntries) {
        countByWinner[e.winnerId] = (countByWinner[e.winnerId] || 0) + 1;
      }
      for (const [winner, count] of Object.entries(countByWinner)) {
        if (count >= 5) {
          return `⚠️ Suspicious activity detected: <@${winner}> has won 5 of 6 matches submitted by <@${submitter}> in the last 30 minutes.`;
        }
      }
    }
  }

  // Criteria 3: Same winner against same group 9 of 10 times
  const opponentKeyMap: Record<string, string[]> = {};
  for (const match of recent) {
    if (match.status === 'w' && !match.submittedByAdmin) {
      const key = JSON.stringify([
        ...JSON.parse(match.allies || '[]'),
        ...JSON.parse(match.enemies || '[]'),
      ].sort());
      if (!opponentKeyMap[match.userId]) opponentKeyMap[match.userId] = [];
      opponentKeyMap[match.userId].push(key);
    }
  }
  for (const [player, keys] of Object.entries(opponentKeyMap)) {
    const countMap: Record<string, number> = {};
    for (const key of keys) {
      countMap[key] = (countMap[key] || 0) + 1;
    }
    for (const count of Object.values(countMap)) {
      if (count >= 9) {
        return `⚠️ Suspicious activity detected: <@${player}> has won 9 matches against the same group.`;
      }
    }
  }

  return null;
}
