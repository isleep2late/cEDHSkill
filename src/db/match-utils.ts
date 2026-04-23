import { getDatabase } from './init.js';

export async function recordMatch(
  matchId: string,
  gameId: string,
  userId: string,
  status: string,
  matchDate: Date,
  mu: number,
  sigma: number,
  teams: string[],
  scores: number[],
  score: number | undefined,
  submittedByAdmin: boolean,
  turnOrder?: number,
  assignedDeck?: string | null  // NEW PARAMETER
): Promise<void> {
  const db = getDatabase();

  await db.run(
    `INSERT INTO matches 
    (id, gameId, userId, status, matchDate, mu, sigma, teams, scores, score, submittedByAdmin, turnOrder, assignedDeck) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      matchId,
      gameId,
      userId,
      status,
      matchDate.toISOString(),
      mu,
      sigma,
      JSON.stringify(teams),
      JSON.stringify(scores),
      score ?? null,
      submittedByAdmin ? 1 : 0,
      turnOrder ?? null,
      assignedDeck ?? null  // CRITICAL: Store the assigned deck
    ]
  );
}


export async function getRecentMatches(userId: string, limit: number = 50): Promise<any[]> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    SELECT * FROM matches 
    WHERE userId = ? 
    ORDER BY matchDate DESC 
    LIMIT ?
  `);
  return await stmt.all(userId, limit);
}

export async function getMatchesByGameId(gameId: string): Promise<any[]> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    SELECT * FROM matches 
    WHERE gameId = ? 
    ORDER BY matchDate DESC
  `);
  return await stmt.all(gameId);
}

export async function deleteMatchesByGameId(gameId: string): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare('DELETE FROM matches WHERE gameId = ?');
  await stmt.run(gameId);
}

export async function updateMatchTurnOrder(matchId: string, userId: string, turnOrder: number): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    UPDATE matches 
    SET turnOrder = ? 
    WHERE id = ? AND userId = ?
  `);
  await stmt.run(turnOrder, matchId, userId);
}

export async function getOpponentsByGameIds(gameIds: string[], userId: string): Promise<Record<string, string[]>> {
  if (gameIds.length === 0) return {};
  const db = getDatabase();
  const placeholders = gameIds.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT gameId, userId FROM matches WHERE gameId IN (${placeholders}) AND userId != ?`,
    [...gameIds, userId]
  ) as { gameId: string; userId: string }[];

  const result: Record<string, string[]> = {};
  for (const row of rows) {
    if (!result[row.gameId]) result[row.gameId] = [];
    result[row.gameId].push(row.userId);
  }
  // Sort each opponent list for consistent key generation
  for (const gameId of Object.keys(result)) {
    result[gameId].sort();
  }
  return result;
}

export async function getTotalMatches(): Promise<number> {
  const db = getDatabase();
  const stmt = await db.prepare('SELECT COUNT(DISTINCT gameId) as count FROM matches');
  const result = await stmt.get() as { count: number };
  return result.count;
}

/**
 * Count how many active games a player has played on the same calendar day (UTC)
 * before the specified game (by gameSequence). Used for daily participation bonus limit.
 */
export async function getPlayerGamesOnDateBefore(userId: string, matchDate: Date, currentGameId: string): Promise<number> {
  const db = getDatabase();
  const dateStr = matchDate.toISOString().split('T')[0];

  const result = await db.get(`
    SELECT COUNT(DISTINCT m.gameId) as count
    FROM matches m
    JOIN games_master gm ON m.gameId = gm.gameId
    WHERE m.userId = ?
    AND DATE(m.matchDate) = ?
    AND gm.active = 1
    AND gm.gameSequence < (SELECT gameSequence FROM games_master WHERE gameId = ?)
  `, [userId, dateStr, currentGameId]) as { count: number } | undefined;

  return result?.count ?? 0;
}

/**
 * Count how many active games a deck has played on the same calendar day (UTC)
 * before the specified game (by gameSequence). Used for daily participation bonus limit.
 */
export async function getDeckGamesOnDateBefore(deckNormalizedName: string, matchDate: Date, currentGameId: string): Promise<number> {
  const db = getDatabase();
  const dateStr = matchDate.toISOString().split('T')[0];

  const result = await db.get(`
    SELECT COUNT(DISTINCT dm.gameId) as count
    FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE dm.deckNormalizedName = ?
    AND DATE(dm.matchDate) = ?
    AND gm.active = 1
    AND gm.gameSequence < (SELECT gameSequence FROM games_master WHERE gameId = ?)
  `, [deckNormalizedName, dateStr, currentGameId]) as { count: number } | undefined;

  return result?.count ?? 0;
}