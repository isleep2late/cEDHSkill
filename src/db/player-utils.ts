import { getDatabase } from './init.js';

export interface TurnOrderStats {
  turnOrder: number;
  wins: number;
  losses: number;
  draws: number;
  totalGames: number;
}

export async function restrictPlayer(userId: string): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare('INSERT OR IGNORE INTO restricted (userId) VALUES (?)');
  await stmt.run(userId);
}

export async function unrestrictPlayer(userId: string): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare('DELETE FROM restricted WHERE userId = ?');
  await stmt.run(userId);
}

export async function isPlayerRestricted(userId: string): Promise<boolean> {
  const db = getDatabase();
  const stmt = await db.prepare('SELECT userId FROM restricted WHERE userId = ?');
  const row = await stmt.get(userId);
  return !!row;
}

export async function getRestrictedPlayers(): Promise<string[]> {
  const db = getDatabase();
  const stmt = await db.prepare('SELECT userId FROM restricted');
  const rows = await stmt.all() as { userId: string }[];
  return rows.map(r => r.userId);
}

export async function getOrCreatePlayer(userId: string) {
  const db = getDatabase();
  
  const selectStmt = await db.prepare(`
    SELECT mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed 
    FROM players WHERE userId = ?
  `);
  const row = await selectStmt.get(userId) as any;

  if (row) {
    return {
      userId,
      mu: row.mu,
      sigma: row.sigma,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      draws: row.draws ?? 0,
      gamesPlayed: row.gamesPlayed ?? 0,
      lastPlayed: row.lastPlayed ?? null,
    };
  } else {
    const mu = 25.0;
    const sigma = 8.333;
    const wins = 0;
    const losses = 0;
    const draws = 0;
    
    const insertStmt = await db.prepare(`
      INSERT INTO players (userId, mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await insertStmt.run(userId, mu, sigma, wins, losses, draws, 0, null);
    
    return { userId, mu, sigma, wins, losses, draws, gamesPlayed: 0, lastPlayed: null };
  }
}

export async function updatePlayerRating(
  userId: string,
  mu: number,
  sigma: number,
  wins: number,
  losses: number,
  draws: number
): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    UPDATE players
    SET mu = ?, sigma = ?, wins = ?, losses = ?, draws = ?,
        gamesPlayed = ?, lastPlayed = ?
    WHERE userId = ?
  `);
  await stmt.run(mu, sigma, wins, losses, draws, wins + losses + draws, new Date().toISOString(), userId);
}

export async function updatePlayerRatingForDecay(
  userId: string,
  mu: number,
  sigma: number,
  wins: number,
  losses: number,
  draws: number
): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    UPDATE players
    SET mu = ?, sigma = ?, wins = ?, losses = ?, draws = ?,
        gamesPlayed = ?
    WHERE userId = ?
  `);
  await stmt.run(mu, sigma, wins, losses, draws, wins + losses + draws, userId);
}

export async function getAllPlayers() {
  const db = getDatabase();
  const stmt = await db.prepare(`
    SELECT userId, mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed 
    FROM players
  `);
  return await stmt.all();
}

export async function getPlayerTurnOrderStats(userId: string): Promise<TurnOrderStats[]> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    SELECT 
      m.turnOrder,
      SUM(CASE WHEN m.status = 'w' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN m.status = 'l' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN m.status = 'd' THEN 1 ELSE 0 END) as draws,
      COUNT(*) as totalGames
    FROM matches m
    JOIN games_master gm ON m.gameId = gm.gameId
    WHERE m.userId = ? AND m.turnOrder IS NOT NULL AND gm.active = 1
    GROUP BY m.turnOrder
    ORDER BY m.turnOrder
  `);
  
  return await stmt.all(userId) as TurnOrderStats[];
}

export async function getAllPlayerTurnOrderStats(): Promise<TurnOrderStats[]> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    SELECT 
      m.turnOrder,
      SUM(CASE WHEN m.status = 'w' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN m.status = 'l' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN m.status = 'd' THEN 1 ELSE 0 END) as draws,
      COUNT(*) as totalGames
    FROM matches m
    JOIN games_master gm ON m.gameId = gm.gameId
    WHERE m.turnOrder IS NOT NULL AND gm.active = 1
    GROUP BY m.turnOrder
    ORDER BY m.turnOrder
  `);
  
  return await stmt.all() as TurnOrderStats[];
}