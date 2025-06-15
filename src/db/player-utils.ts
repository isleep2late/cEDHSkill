// src/db/player-utils.ts
import { dbPromise } from './init.js';

/**
 * Mark a player as restricted (cannot play ranked).
 */
export async function restrictPlayer(userId: string): Promise<void> {
  const db = await dbPromise;
  await db.run(`
    CREATE TABLE IF NOT EXISTS restricted (
      userId TEXT PRIMARY KEY
    );
  `);
  await db.run(
    `INSERT OR IGNORE INTO restricted (userId) VALUES (?);`,
    userId
  );
}

/**
 * Lift the restriction so they can play again.
 */
export async function unrestrictPlayer(userId: string): Promise<void> {
  const db = await dbPromise;
  await db.run(
    `DELETE FROM restricted WHERE userId = ?;`,
    userId
  );
}

/**
 * Check if a user is currently restricted.
 */
export async function isPlayerRestricted(userId: string): Promise<boolean> {
  const db = await dbPromise;
  const row = await db.get<{ userId: string }>(
    `SELECT userId FROM restricted WHERE userId = ?;`,
    userId
  );
  return !!row;
}

/**
 * Return all restricted user IDs (for bulk filtering).
 */
export async function getRestrictedPlayers(): Promise<string[]> {
  const db = await dbPromise;
  // ← tell TS it's an array of records
  const rows = await db.all<{ userId: string }[]>(`
    SELECT userId FROM restricted
  `);
  return rows.map(r => r.userId);
}

export async function getOrCreatePlayer(userId: string) {
    const db = await dbPromise;

    const row = await db.get(
        'SELECT mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed FROM players WHERE userId = ?',
        userId
    );

    if (row) {
        return {
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
        await db.run(
            'INSERT INTO players (userId, mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            userId,
            mu,
            sigma,
            wins,
            losses,
            draws,
            0,
            null
        );
        return {
            mu,
            sigma,
            wins,
            losses,
            draws,
            gamesPlayed: 0,
            lastPlayed: null,
        };
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
    const db = await dbPromise;
    await db.run(
        'UPDATE players SET mu = ?, sigma = ?, wins = ?, losses = ?, draws = ?, gamesPlayed = ?, lastPlayed = ? WHERE userId = ?',
        mu,
        sigma,
        wins,
        losses,
        draws,
        wins + losses + draws,
        new Date().toISOString(),
        userId
    );
}

export async function getAllPlayers() {
    const db = await dbPromise;
    return await db.all(
        'SELECT userId, mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed FROM players'
    );
}
