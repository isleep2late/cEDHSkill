import { getDatabase } from './init.js';

export interface Deck {
  normalizedName: string;
  displayName: string;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
  draws: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeckMatch {
  id: string;
  gameId: string;
  deckNormalizedName: string;
  deckDisplayName: string;
  status: 'w' | 'l' | 'd';
  matchDate: Date;
  mu: number;
  sigma: number;
  turnOrder?: number;
  createdAt?: string;
}

export interface TurnOrderStats {
  turnOrder: number;
  wins: number;
  losses: number;
  draws: number;
  totalGames: number;
}

export async function getOrCreateDeck(normalizedName: string, displayName: string): Promise<Deck> {
  const db = getDatabase();
  
  const selectStmt = await db.prepare('SELECT * FROM decks WHERE normalizedName = ?');
  let deck = await selectStmt.get(normalizedName) as Deck | undefined;
  
  if (!deck) {
    const insertStmt = await db.prepare(`
      INSERT INTO decks (normalizedName, displayName, mu, sigma, wins, losses, draws)
      VALUES (?, ?, 25.0, 8.333, 0, 0, 0)
    `);
    
    await insertStmt.run(normalizedName, displayName);
    deck = await selectStmt.get(normalizedName) as Deck;
  }
  
  return deck;
}

export async function updateDeckRating(
  normalizedName: string,
  displayName: string,
  mu: number,
  sigma: number,
  wins: number,
  losses: number,
  draws: number
): Promise<void> {
  const db = getDatabase();
  const updateStmt = await db.prepare(`
    UPDATE decks 
    SET displayName = ?, mu = ?, sigma = ?, wins = ?, losses = ?, draws = ?, 
        updatedAt = datetime('now')
    WHERE normalizedName = ?
  `);
  
  await updateStmt.run(displayName, mu, sigma, wins, losses, draws, normalizedName);
}

export async function recordDeckMatch(
  matchId: string,
  gameId: string,
  normalizedName: string,
  displayName: string,
  status: 'w' | 'l' | 'd',
  matchDate: Date,
  mu: number,
  sigma: number,
  turnOrder?: number
): Promise<void> {
  const db = getDatabase();
  const insertStmt = await db.prepare(`
    INSERT INTO deck_matches (id, gameId, deckNormalizedName, deckDisplayName, status, matchDate, mu, sigma, turnOrder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  await insertStmt.run(matchId, gameId, normalizedName, displayName, status, matchDate.toISOString(), mu, sigma, turnOrder);
}

export async function getDeckMatchesByGameId(gameId: string): Promise<DeckMatch[]> {
  const db = getDatabase();
  const selectStmt = await db.prepare(`
    SELECT * FROM deck_matches 
    WHERE gameId = ? 
    ORDER BY matchDate DESC
  `);
  
  const matches = await selectStmt.all(gameId) as any[];
  return matches.map(match => ({
    ...match,
    matchDate: new Date(match.matchDate)
  }));
}

export async function deleteDeckMatchesByGameId(gameId: string): Promise<void> {
  const db = getDatabase();
  const stmt = await db.prepare('DELETE FROM deck_matches WHERE gameId = ?');
  await stmt.run(gameId);
}

export async function getAllDecks(): Promise<Deck[]> {
  const db = getDatabase();
  const selectStmt = await db.prepare('SELECT * FROM decks ORDER BY mu DESC');
  return await selectStmt.all() as Deck[];
}

export async function getDeck(normalizedName: string): Promise<Deck | undefined> {
  const db = getDatabase();
  const selectStmt = await db.prepare('SELECT * FROM decks WHERE normalizedName = ?');
  return await selectStmt.get(normalizedName) as Deck | undefined;
}

export async function getRecentDeckMatches(normalizedName: string, limit: number = 50): Promise<DeckMatch[]> {
  const db = getDatabase();
  const selectStmt = await db.prepare(`
    SELECT dm.* FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE dm.deckNormalizedName = ? AND gm.active = 1
    ORDER BY dm.matchDate DESC 
    LIMIT ?
  `);
  
  const matches = await selectStmt.all(normalizedName, limit) as any[];
  return matches.map(match => ({
    ...match,
    matchDate: new Date(match.matchDate)
  }));
}

export async function getDeckTurnOrderStats(normalizedName: string): Promise<TurnOrderStats[]> {
  const db = getDatabase();
  const selectStmt = await db.prepare(`
    SELECT 
      dm.turnOrder,
      SUM(CASE WHEN dm.status = 'w' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN dm.status = 'l' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN dm.status = 'd' THEN 1 ELSE 0 END) as draws,
      COUNT(*) as totalGames
    FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE dm.deckNormalizedName = ? AND dm.turnOrder IS NOT NULL AND gm.active = 1
    GROUP BY dm.turnOrder
    ORDER BY dm.turnOrder
  `);
  
  return await selectStmt.all(normalizedName) as TurnOrderStats[];
}

export async function getTotalDeckMatches(): Promise<number> {
  const db = getDatabase();
  const selectStmt = await db.prepare(`
    SELECT COUNT(DISTINCT dm.gameId) as count 
    FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE gm.active = 1
  `);
  const result = await selectStmt.get() as { count: number };
  return result.count;
}

export async function getDeckStats(): Promise<{
  totalDecks: number;
  decksWithGames: number;
  qualifiedDecks: number;
  totalMatches: number;
  avgGamesPerDeck: number;
}> {
  const db = getDatabase();
  
  const totalDecksStmt = await db.prepare('SELECT COUNT(*) as count FROM decks');
  const totalDecks = (await totalDecksStmt.get() as { count: number }).count;
  
  const decksWithGamesStmt = await db.prepare('SELECT COUNT(*) as count FROM decks WHERE wins + losses + draws > 0');
  const decksWithGames = (await decksWithGamesStmt.get() as { count: number }).count;
  
  const qualifiedDecksStmt = await db.prepare('SELECT COUNT(*) as count FROM decks WHERE wins + losses + draws >= 5');
  const qualifiedDecks = (await qualifiedDecksStmt.get() as { count: number }).count;
  
  const totalMatches = await getTotalDeckMatches();
  const avgGamesPerDeck = decksWithGames > 0 ? totalMatches / decksWithGames : 0;
  
  return {
    totalDecks,
    decksWithGames,
    qualifiedDecks,
    totalMatches,
    avgGamesPerDeck
  };
}

export async function searchDecks(searchTerm: string, limit: number = 10): Promise<Deck[]> {
  const db = getDatabase();
  const selectStmt = await db.prepare(`
    SELECT * FROM decks 
    WHERE displayName LIKE ? OR normalizedName LIKE ?
    ORDER BY mu DESC 
    LIMIT ?
  `);
  
  const searchPattern = `%${searchTerm}%`;
  return await selectStmt.all(searchPattern, searchPattern, limit) as Deck[];
}