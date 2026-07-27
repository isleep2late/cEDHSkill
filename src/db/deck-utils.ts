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
  
  let deck = await db.get('SELECT * FROM decks WHERE normalizedName = ?', normalizedName) as Deck | undefined;

  if (!deck) {
    // Use INSERT OR IGNORE to prevent race conditions if two calls happen concurrently
    await db.run(`
      INSERT OR IGNORE INTO decks (normalizedName, displayName, mu, sigma, wins, losses, draws)
      VALUES (?, ?, 25.0, 8.333, 0, 0, 0)
    `, normalizedName, displayName);
    deck = await db.get('SELECT * FROM decks WHERE normalizedName = ?', normalizedName) as Deck;
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
  await db.run(`
    UPDATE decks
    SET displayName = ?, mu = ?, sigma = ?, wins = ?, losses = ?, draws = ?,
        updatedAt = datetime('now')
    WHERE normalizedName = ?
  `, displayName, mu, sigma, wins, losses, draws, normalizedName);
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
  turnOrder?: number,
  assignedPlayer?: string | null
): Promise<void> {
  const db = getDatabase();
  await db.run(`
    INSERT INTO deck_matches (id, gameId, deckNormalizedName, deckDisplayName, status, matchDate, mu, sigma, turnOrder, assignedPlayer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, matchId, gameId, normalizedName, displayName, status, matchDate.toISOString(), mu, sigma, turnOrder ?? null, assignedPlayer ?? null);
}

export async function getDeckMatchesByGameId(gameId: string): Promise<DeckMatch[]> {
  const db = getDatabase();
  const matches = await db.all(`
    SELECT * FROM deck_matches
    WHERE gameId = ?
    ORDER BY matchDate DESC
  `, gameId) as any[];
  return matches.map(match => ({
    ...match,
    matchDate: new Date(match.matchDate)
  }));
}

export async function deleteDeckMatchesByGameId(gameId: string): Promise<void> {
  const db = getDatabase();
  await db.run('DELETE FROM deck_matches WHERE gameId = ?', gameId);
}

export async function getAllDecks(): Promise<Deck[]> {
  const db = getDatabase();
  return await db.all('SELECT * FROM decks ORDER BY mu DESC') as Deck[];
}

export async function getDeck(normalizedName: string): Promise<Deck | undefined> {
  const db = getDatabase();
  return await db.get('SELECT * FROM decks WHERE normalizedName = ?', normalizedName) as Deck | undefined;
}

export async function getRecentDeckMatches(normalizedName: string, limit: number = 50): Promise<DeckMatch[]> {
  const db = getDatabase();
  const matches = await db.all(`
    SELECT dm.* FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE dm.deckNormalizedName = ? AND gm.active = 1
    ORDER BY dm.matchDate DESC
    LIMIT ?
  `, normalizedName, limit) as any[];
  return matches.map(match => ({
    ...match,
    matchDate: new Date(match.matchDate)
  }));
}

export async function getDeckTurnOrderStats(normalizedName: string): Promise<TurnOrderStats[]> {
  const db = getDatabase();
  return await db.all(`
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
  `, normalizedName) as TurnOrderStats[];
}

export async function getTotalDeckMatches(): Promise<number> {
  const db = getDatabase();
  const result = await db.get(`
    SELECT COUNT(DISTINCT dm.gameId) as count
    FROM deck_matches dm
    JOIN games_master gm ON dm.gameId = gm.gameId
    WHERE gm.active = 1
  `) as { count: number };
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
  
  const totalDecks = (await db.get('SELECT COUNT(*) as count FROM decks') as { count: number }).count;

  const decksWithGames = (await db.get('SELECT COUNT(*) as count FROM decks WHERE wins + losses + draws > 0') as { count: number }).count;

  const qualifiedDecks = (await db.get('SELECT COUNT(*) as count FROM decks WHERE wins + losses + draws >= 5') as { count: number }).count;
  
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
  const searchPattern = `%${searchTerm}%`;
  return await db.all(`
    SELECT * FROM decks
    WHERE displayName LIKE ? OR normalizedName LIKE ?
    ORDER BY mu DESC
    LIMIT ?
  `, searchPattern, searchPattern, limit) as Deck[];
}