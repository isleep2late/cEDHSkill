import { getDatabase } from '../db/init.js';

export async function exemptPlayer(userId: string): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare('INSERT OR IGNORE INTO suspicionExempt (userId) VALUES (?)');
  await stmt.run(userId);
}

export async function removeExemption(userId: string): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare('DELETE FROM suspicionExempt WHERE userId = ?');
  await stmt.run(userId);
}

export async function isExempt(userId: string): Promise<boolean> {
  const db = getDatabase();
  const stmt = await db.prepare('SELECT userId FROM suspicionExempt WHERE userId = ?');
  const row = await stmt.get(userId);
  return !!row;
}

export async function setAlertOptIn(userId: string, optIn: boolean): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare(`
    INSERT OR REPLACE INTO adminOptIn (userId, optIn) VALUES (?, ?)
  `);
  await stmt.run(userId, optIn ? 1 : 0);
}

export async function getAlertOptIn(userId: string): Promise<boolean> {
  const db = getDatabase();
  const stmt = await db.prepare('SELECT optIn FROM adminOptIn WHERE userId = ?');
  const row = await stmt.get(userId) as { optIn: number } | undefined;
  
  if (!row) {
    // Import config to check if user is admin or moderator
    const { config } = await import('../config.js');
    
    // Default to opted-in for both admins and moderators
    if (config.admins.includes(userId) || config.moderators.includes(userId)) {
      await setAlertOptIn(userId, true);
      return true;
    }
    
    return false; // Non-admin/mod users default to false
  }
  return row.optIn === 1;
}