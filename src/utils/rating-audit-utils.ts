// src/utils/rating-audit-utils.ts
import { calculateElo } from './elo-utils.js';
import { logger } from './logger.js';

export interface RatingChange {
  targetType: 'player' | 'deck';
  targetId: string;
  targetDisplayName: string;
  changeType: 'manual' | 'game' | 'decay' | 'wld_adjustment' | 'undo' | 'redo';
  adminUserId?: string;
  oldMu: number;
  oldSigma: number;
  oldElo: number;
  newMu: number;
  newSigma: number;
  newElo: number;
  oldWins?: number;
  oldLosses?: number;
  oldDraws?: number;
  newWins?: number;
  newLosses?: number;
  newDraws?: number;
  parameters?: string; // JSON string for manual changes
  reason?: string;
  timestamp?: string;
}

export async function logRatingChange(change: RatingChange): Promise<void> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  await db.run(`
    INSERT INTO rating_changes (
      targetType, targetId, targetDisplayName, changeType, adminUserId,
      oldMu, oldSigma, oldElo, newMu, newSigma, newElo,
      oldWins, oldLosses, oldDraws, newWins, newLosses, newDraws,
      parameters, reason, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    change.targetType,
    change.targetId,
    change.targetDisplayName,
    change.changeType,
    change.adminUserId || null,
    change.oldMu,
    change.oldSigma,
    change.oldElo,
    change.newMu,
    change.newSigma,
    change.newElo,
    change.oldWins || null,
    change.oldLosses || null,
    change.oldDraws || null,
    change.newWins || null,
    change.newLosses || null,
    change.newDraws || null,
    change.parameters || null,
    change.reason || null,
    change.timestamp || new Date().toISOString()
  ]);

  logger.info(`[AUDIT] Logged ${change.changeType} rating change for ${change.targetType} ${change.targetDisplayName}`);
}

export async function getRatingChangesForTarget(
  targetType: 'player' | 'deck', 
  targetId: string, 
  limit: number = 50
): Promise<RatingChange[]> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  const rows = await db.all(`
    SELECT * FROM rating_changes 
    WHERE targetType = ? AND targetId = ? 
    ORDER BY timestamp DESC 
    LIMIT ?
  `, [targetType, targetId, limit]);

  return rows as RatingChange[];
}

export async function getAllRatingChanges(
  limit: number = 100,
  changeType?: 'manual' | 'game' | 'decay' | 'wld_adjustment' | 'undo' | 'redo' | 'undo_or_redo'
): Promise<RatingChange[]> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  let query = 'SELECT * FROM rating_changes';
  const params: any[] = [];

  if (changeType) {
    if (changeType === 'undo_or_redo') {
      query += ' WHERE changeType IN (?, ?)';
      params.push('undo', 'redo');
    } else {
      query += ' WHERE changeType = ?';
      params.push(changeType);
    }
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = await db.all(query, params);
  return rows as RatingChange[];
}

export async function getManualChangesForAdmin(adminUserId: string): Promise<RatingChange[]> {
  const { getDatabase } = await import('../db/init.js');
  const db = getDatabase();

  const rows = await db.all(`
    SELECT * FROM rating_changes 
    WHERE changeType = 'manual' AND adminUserId = ? 
    ORDER BY timestamp DESC
  `, [adminUserId]);

  return rows as RatingChange[];
}