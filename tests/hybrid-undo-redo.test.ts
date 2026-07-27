/**
 * Integration test: /undo and /redo of a hybrid player game.
 *
 * A "hybrid" game is a player game where at least one player has a commander/deck
 * assigned (which happens automatically when a player has a defaultDeck). The game
 * updates both the players table and the decks/deck_matches tables, so undo must
 * revert the deck's rating and delete its deck_matches rows, and redo must restore
 * both exactly.
 *
 * Run with: npm test  (uses tsx; no Discord connection required)
 */

// Required by src/config.ts — must be set before any project module is imported.
process.env.DISCORD_TOKEN ??= 'test-token';
process.env.CLIENT_ID ??= 'test-client-id';
process.env.GUILD_ID ??= 'test-guild-id';
process.env.ADMINS = 'admin-user';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// Columns of a deck_matches row that must survive the undo → redo round trip.
// (gameSequence/createdAt are intentionally excluded: recordDeckMatch leaves them
// at their defaults, while redo re-stamps them from the snapshot.)
const DECK_MATCH_COLUMNS = [
  'id', 'gameId', 'deckNormalizedName', 'deckDisplayName',
  'status', 'matchDate', 'mu', 'sigma', 'turnOrder'
] as const;

const DECK_COLUMNS = ['normalizedName', 'displayName', 'mu', 'sigma', 'wins', 'losses', 'draws'] as const;
const PLAYER_COLUMNS = ['userId', 'mu', 'sigma', 'wins', 'losses', 'draws'] as const;

function pick(row: any, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) out[col] = row?.[col];
  return out;
}

// Minimal stand-ins for the Discord objects the command handlers touch.
// Every message-sending call is a no-op; username lookups fail into the
// commands' existing fallback paths.
function fakeInteraction(userId: string): any {
  return {
    user: { id: userId },
    client: { users: { fetch: async () => { throw new Error('no Discord in tests'); } } },
    reply: async () => {},
    deferReply: async () => {},
    editReply: async () => {},
    followUp: async () => {},
  };
}

const fakeReplyMsg: any = { channel: { send: async () => {} } };
const fakeClient: any = {
  user: { id: 'bot-user' },
  users: { fetch: async () => ({ send: async () => {} }) },
};

async function main(): Promise<void> {
  // src/db/init.ts resolves data/cEDHSkill.db relative to the CWD at import time,
  // so switch to a temp dir before importing any project module.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cedhskill-hybrid-undo-redo-'));
  process.chdir(tempDir);

  const { initDatabase, getDatabase } = await import('../src/db/init.js');
  await initDatabase();
  const db = getDatabase();

  const { getOrCreatePlayer } = await import('../src/db/player-utils.js');
  const { getOrCreateDeck, updateDeckRating } = await import('../src/db/deck-utils.js');
  const { recordGameId } = await import('../src/utils/game-id-utils.js');
  const { processGameResults } = await import('../src/commands/rank.js');
  const undoCommand = await import('../src/commands/undo.js');
  const redoCommand = await import('../src/commands/redo.js');
  const { rating } = await import('openskill');

  // --- Seed: four players; player-1 has a defaultDeck, making the game hybrid
  const playerIds = ['player-1', 'player-2', 'player-3', 'player-4'];
  for (const id of playerIds) await getOrCreatePlayer(id);

  const deckName = 'tymna-the-weaver';
  const deckDisplay = 'Tymna the Weaver';
  await getOrCreateDeck(deckName, deckDisplay);
  // Give the deck prior history from a real active game so post-undo cleanup keeps it
  // (cleanupZeroDecks removes decks with no deck_matches rows in active games)
  await updateDeckRating(deckName, deckDisplay, 26.5, 8.0, 1, 0, 0);
  const priorDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await recordGameId('PRIOR1', 'deck');
  await db.run(`
    INSERT INTO games_master (gameId, gameSequence, gameType, submittedBy, submittedByAdmin, status, active)
    VALUES ('PRIOR1', 0.5, 'deck', 'admin-user', 1, 'confirmed', 1)
  `);
  await db.run(`
    INSERT INTO deck_matches (id, gameId, deckNormalizedName, deckDisplayName, status, matchDate, mu, sigma, turnOrder)
    VALUES ('prior-match-1', 'PRIOR1', ?, ?, 'w', ?, 26.5, 8.0, 1)
  `, [deckName, deckDisplay, priorDate]);
  await db.run('UPDATE players SET defaultDeck = ? WHERE userId = ?', [deckName, 'player-1']);

  // --- Register the game the way /rank does before processing results
  const gameId = 'HYBRID1';
  const gameSequence = 1;
  const matchId = crypto.randomUUID();
  const gameDate = new Date();
  await recordGameId(gameId, 'player');
  await db.run(`
    INSERT INTO games_master (gameId, gameSequence, gameType, submittedBy, submittedByAdmin, status, active)
    VALUES (?, ?, 'player', 'admin-user', 1, 'pending', 1)
  `, [gameId, gameSequence]);

  const players = playerIds.map((userId, i) => ({
    userId,
    status: i === 0 ? 'w' : 'l',
    turnOrder: i + 1,
  }));
  const preRatings: Record<string, any> = {};
  const records: Record<string, any> = {};
  const userNames: Record<string, string> = {};
  for (const id of playerIds) {
    const pd = await getOrCreatePlayer(id);
    preRatings[id] = rating({ mu: pd.mu, sigma: pd.sigma });
    records[id] = { wins: pd.wins, losses: pd.losses, draws: pd.draws, lastPlayed: pd.lastPlayed };
    userNames[id] = `@${id}`;
  }

  const deckPreGame = await db.get('SELECT * FROM decks WHERE normalizedName = ?', deckName);

  // --- Submit the game
  await processGameResults(
    players, preRatings, records, userNames, matchId, gameId, gameSequence,
    players.length, true, 'admin-user', fakeReplyMsg, fakeClient, false, gameDate
  );

  const deckPostGame = await db.get('SELECT * FROM decks WHERE normalizedName = ?', deckName);
  const deckMatchesPostGame = await db.all(
    'SELECT * FROM deck_matches WHERE gameId = ? ORDER BY id', gameId);
  const playersPostGame = await db.all(
    'SELECT * FROM players WHERE userId IN (?, ?, ?, ?) ORDER BY userId', playerIds);

  // Sanity: the game actually touched the deck (auto-assigned from defaultDeck)
  assert.equal(deckMatchesPostGame.length, 1, 'hybrid game should record one deck_matches row');
  assert.equal(deckPostGame.wins, 2, 'deck should gain the win');
  assert.notEqual(deckPostGame.mu, deckPreGame.mu, 'deck mu should change from the game');
  const assignedDeck = await db.get(
    'SELECT assignedDeck FROM matches WHERE gameId = ? AND userId = ?', [gameId, 'player-1']);
  assert.equal(assignedDeck.assignedDeck, deckName, 'defaultDeck should be auto-assigned');

  // --- /undo
  await undoCommand.execute(fakeInteraction('admin-user'));

  const deckPostUndo = await db.get('SELECT * FROM decks WHERE normalizedName = ?', deckName);
  assert.deepEqual(
    pick(deckPostUndo, DECK_COLUMNS), pick(deckPreGame, DECK_COLUMNS),
    'undo must revert the deck row to its pre-game state');

  const deckMatchesPostUndo = await db.all('SELECT * FROM deck_matches WHERE gameId = ?', gameId);
  assert.equal(deckMatchesPostUndo.length, 0, 'undo must delete the game\'s deck_matches rows');

  const matchesPostUndo = await db.all('SELECT * FROM matches WHERE gameId = ?', gameId);
  assert.equal(matchesPostUndo.length, 0, 'undo must delete the game\'s matches rows');

  const gamePostUndo = await db.get('SELECT status FROM games_master WHERE gameId = ?', gameId);
  assert.equal(gamePostUndo.status, 'undone', 'undo must mark the game as undone');

  // Players started at 0/0/0, so post-undo cleanup removes them (redo recreates them)
  const playersPostUndo = await db.all(
    'SELECT * FROM players WHERE userId IN (?, ?, ?, ?)', playerIds);
  assert.equal(playersPostUndo.length, 0, 'cleanup should remove reverted 0/0/0 players');

  // --- /redo
  await redoCommand.execute(fakeInteraction('admin-user'));

  const deckPostRedo = await db.get('SELECT * FROM decks WHERE normalizedName = ?', deckName);
  assert.deepEqual(
    pick(deckPostRedo, DECK_COLUMNS), pick(deckPostGame, DECK_COLUMNS),
    'redo must restore the deck row to its post-game state');

  const deckMatchesPostRedo = await db.all(
    'SELECT * FROM deck_matches WHERE gameId = ? ORDER BY id', gameId);
  assert.deepEqual(
    deckMatchesPostRedo.map(r => pick(r, DECK_MATCH_COLUMNS)),
    deckMatchesPostGame.map(r => pick(r, DECK_MATCH_COLUMNS)),
    'redo must re-insert the game\'s deck_matches rows exactly');

  const playersPostRedo = await db.all(
    'SELECT * FROM players WHERE userId IN (?, ?, ?, ?) ORDER BY userId', playerIds);
  assert.deepEqual(
    playersPostRedo.map(r => pick(r, PLAYER_COLUMNS)),
    playersPostGame.map(r => pick(r, PLAYER_COLUMNS)),
    'redo must restore player ratings to their post-game state');

  const matchesPostRedo = await db.all('SELECT * FROM matches WHERE gameId = ?', gameId);
  assert.equal(matchesPostRedo.length, players.length, 'redo must restore the matches rows');

  const gamePostRedo = await db.get('SELECT status FROM games_master WHERE gameId = ?', gameId);
  assert.equal(gamePostRedo.status, 'confirmed', 'redo must re-confirm the game');

  // No closeDatabase(): the repo's helpers leave prepared statements open, which
  // makes the shutdown checkpoint log a spurious SQLITE_LOCKED error. The temp
  // database is deleted and the process exits, so skipping close is safe here.
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('PASS: hybrid game undo/redo round-trips deck ratings and deck_matches');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('FAIL:', err);
    process.exit(1);
  });
