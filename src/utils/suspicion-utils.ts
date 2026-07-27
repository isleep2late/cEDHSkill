import { getDatabase } from '../db/init.js';

export async function exemptPlayer(userId: string): Promise<void> {
  const db = getDatabase();
  await db.run('INSERT OR IGNORE INTO suspicionExempt (userId) VALUES (?)', userId);
}

export async function removeExemption(userId: string): Promise<void> {
  const db = getDatabase();
  await db.run('DELETE FROM suspicionExempt WHERE userId = ?', userId);
}

export async function isExempt(userId: string): Promise<boolean> {
  const db = getDatabase();
  const row = await db.get('SELECT userId FROM suspicionExempt WHERE userId = ?', userId);
  return !!row;
}

export async function setAlertOptIn(userId: string, optIn: boolean): Promise<void> {
  const db = getDatabase();
  await db.run('INSERT OR REPLACE INTO adminOptIn (userId, optIn) VALUES (?, ?)', userId, optIn ? 1 : 0);
}

export async function getAlertOptIn(userId: string): Promise<boolean> {
  const db = getDatabase();
  const row = await db.get('SELECT optIn FROM adminOptIn WHERE userId = ?', userId) as { optIn: number } | undefined;
  
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