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
  return await db.all(`
    SELECT * FROM matches
    WHERE userId = ?
    ORDER BY matchDate DESC
    LIMIT ?
  `, userId, limit);
}

export async function getMatchesByGameId(gameId: string): Promise<any[]> {
  const db = getDatabase();
  return await db.all(`
    SELECT * FROM matches
    WHERE gameId = ?
    ORDER BY matchDate DESC
  `, gameId);
}

export async function deleteMatchesByGameId(gameId: string): Promise<void> {
  const db = getDatabase();
  await db.run('DELETE FROM matches WHERE gameId = ?', gameId);
}

/**
 * Set (or clear, with null) a player's turn order for a recorded game.
 * For hybrid games the player's assigned deck has a matching deck_matches
 * row; keep its turnOrder in sync so deck turn-order stats stay accurate.
 */
export async function setPlayerTurnOrderForGame(gameId: string, userId: string, turnOrder: number | null): Promise<void> {
  const db = getDatabase();
  const row = await db.get(
    'SELECT turnOrder, assignedDeck FROM matches WHERE gameId = ? AND userId = ?',
    [gameId, userId]
  );
  if (!row) return;

  await db.run(
    'UPDATE matches SET turnOrder = ? WHERE gameId = ? AND userId = ?',
    [turnOrder, gameId, userId]
  );

  if (row.assignedDeck) {
    // Hybrid deck rows record assignedPlayer, giving an exact per-player match.
    const synced = await db.run(
      'UPDATE deck_matches SET turnOrder = ? WHERE gameId = ? AND assignedPlayer = ?',
      [turnOrder, gameId, userId]
    );
    if ((synced?.changes ?? 0) === 0) {
      // Legacy rows recorded before assignedPlayer was populated: best-effort
      // match on the deck name and the old turn value — but only when the
      // match is unambiguous (duplicate commanders could otherwise get the
      // wrong pilot's row updated).
      const candidates = await db.get(
        'SELECT COUNT(*) as count FROM deck_matches WHERE gameId = ? AND deckNormalizedName = ? AND turnOrder IS ? AND assignedPlayer IS NULL',
        [gameId, row.assignedDeck, row.turnOrder]
      );
      if (candidates?.count === 1) {
        await db.run(
          'UPDATE deck_matches SET turnOrder = ? WHERE gameId = ? AND deckNormalizedName = ? AND turnOrder IS ? AND assignedPlayer IS NULL',
          [turnOrder, gameId, row.assignedDeck, row.turnOrder]
        );
      }
    }
  }
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
  const result = await db.get('SELECT COUNT(DISTINCT gameId) as count FROM matches') as { count: number };
  return result.count;
}