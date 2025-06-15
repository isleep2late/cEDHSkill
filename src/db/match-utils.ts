// src/db/match-utils.ts
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const dbPromise = open({
  filename: path.resolve('data', 'database.sqlite'),
  driver: sqlite3.Database
});

export async function recordMatch(
  matchId: string,
  userId: string,
  status: string,
  timestamp: Date,
  mu: number,
  sigma: number,
  allies: string[],
  enemies: string[],
  score?: number,
  submittedByAdmin: boolean = false
) {
  const db = await dbPromise;
  await db.run(
    `INSERT INTO matches (id, userId, status, timestamp, mu, sigma, allies, enemies, score, submittedByAdmin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    matchId,
    userId,
    status,
    timestamp.toISOString(),
    mu,
    sigma,
    JSON.stringify(allies),
    JSON.stringify(enemies),
    score ?? null,
    submittedByAdmin ? 1 : 0
  );
}

export async function getRecentMatches(userId: string, limit = 50): Promise<any[]> {
  const db = await dbPromise;
  return await db.all(
    'SELECT * FROM matches WHERE userId = ? ORDER BY timestamp DESC LIMIT ?',
    userId,
    limit
  );
}

export async function restrictPlayer(userId: string) {
  const db = await dbPromise;
  await db.run('INSERT OR IGNORE INTO restricted (userId) VALUES (?)', userId);
}

export async function vindicatePlayer(userId: string) {
  const db = await dbPromise;
  await db.run('DELETE FROM restricted WHERE userId = ?', userId);
}

export async function isRestricted(userId: string): Promise<boolean> {
  const db = await dbPromise;
  const row = await db.get('SELECT userId FROM restricted WHERE userId = ?', userId);
  return !!row;
}

//
// Ensure our admin-opt-in table exists as soon as this module is loaded
//
(async () => {
  const db = await dbPromise;
  await db.run(`
    CREATE TABLE IF NOT EXISTS adminOptIn (
      userId TEXT PRIMARY KEY,
      optIn INTEGER NOT NULL
    );
  `);
})();

/**
 * Set whether an admin wants to receive alerts.
 * @param userId Discord user ID
 * @param optIn   true = receive alerts, false = do not receive
 */
export async function setAdminOptIn(userId: string, optIn: boolean): Promise<void> {
  const db = await dbPromise;
  // Insert or update
  await db.run(
    `INSERT INTO adminOptIn (userId, optIn)
     VALUES (?, ?)
     ON CONFLICT(userId) DO UPDATE SET optIn = excluded.optIn;`,
    userId,
    optIn ? 1 : 0
  );
}

/**
 * Get whether an admin wants to receive alerts.
 * Defaults to true (opted in) if no record exists.
 */
export async function getAdminOptIn(userId: string): Promise<boolean> {
  const db = await dbPromise;
  const row = await db.get<{ optIn: number }>(
    `SELECT optIn FROM adminOptIn WHERE userId = ?`,
    userId
  );
  if (!row) {
    // If the user has never been seen before, default them to opted in
    await setAdminOptIn(userId, true);
    return true;
  }
  return row.optIn === 1;
}
