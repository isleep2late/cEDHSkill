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

export async function getTotalMatches(): Promise<number> {
  const db = getDatabase();
  const stmt = await db.prepare('SELECT COUNT(DISTINCT gameId) as count FROM matches');
  const result = await stmt.get() as { count: number };
  return result.count;
}