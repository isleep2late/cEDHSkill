/**
 * Regression test: consecutive /timewalk runs must accumulate decay.
 *
 * Bug: applyRatingDecay's timewalk branch computed the decay target by
 * subtracting only the NEW virtual days past grace from the player's full
 * pre-decay baseline Elo. Because the target is compared against the
 * player's CURRENT (already-decayed) Elo and skipped when target >= current,
 * every timewalk after the first under-decayed:
 *   /timewalk +8 -> 1388 -> 1386 (correct)
 *   /timewalk +1 -> target 1388-1=1387 >= 1386 -> skipped (should be 1385)
 *
 * The fix computes the target from the TOTAL virtual days past grace, so
 * consecutive timewalks land exactly where a single equivalent timewalk would.
 *
 * Run with: npm test   (or: npx tsx tests/decay-timewalk-regression.test.ts)
 *
 * Uses the real applyRatingDecay/virtual-clock functions against a fresh
 * SQLite database in a temp directory. No Discord connection is made.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// src/config.ts (imported transitively by bot.ts) throws if these are unset.
process.env.DISCORD_TOKEN ??= 'test-token';
process.env.CLIENT_ID ??= 'test-client-id';
process.env.GUILD_ID ??= 'test-guild-id';
// The scenario below assumes the default 6-day grace period.
process.env.DECAY_START_DAYS = '6';

// src/db/init.ts resolves its data/ directory from cwd at import time, so
// chdir into a fresh temp dir BEFORE importing anything that touches the DB.
const originalCwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cedhskill-decay-test-'));
process.chdir(tmpDir);

const { initDatabase, getDatabase, closeDatabase } = await import('../src/db/init.js');
await initDatabase();
const db = getDatabase();

const { applyRatingDecay, addTimewalkDays, recordPlayerActivity, resetTimewalkDays } =
  await import('../src/bot.js');
const { calculateElo } = await import('../src/utils/elo-utils.js');

let failures = 0;
function assertEqual(actual: number, expected: number, label: string): void {
  if (actual === expected) {
    console.log(`  PASS: ${label} (${actual})`);
  } else {
    console.error(`  FAIL: ${label} — expected ${expected}, got ${actual}`);
    failures++;
  }
}

async function playerState(userId: string): Promise<{ mu: number; sigma: number; elo: number }> {
  const row = await db.get('SELECT mu, sigma FROM players WHERE userId = ?', userId);
  return { mu: row.mu, sigma: row.sigma, elo: calculateElo(row.mu, row.sigma) };
}

/** Mirror the /timewalk command: apply decay, then advance the virtual clock. */
async function timewalk(days: number): Promise<number> {
  const decayedCount = await applyRatingDecay('timewalk', 'test-admin', days, true);
  addTimewalkDays(days);
  return decayedCount;
}

// --- Setup: player "erin" with mu=27.5, sigma=preDecaySigma=4.0 -> Elo 1388,
// last played "now" (real clock) and at virtual day 0. Player "floor" sits at
// Elo 1000, below the ELO_CUTOFF (1050) — decay must never touch them.
resetTimewalkDays();
await db.run(
  `INSERT INTO players (userId, mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed, preDecaySigma)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ['erin', 27.5, 4.0, 1, 0, 0, 1, new Date().toISOString(), 4.0]
);
recordPlayerActivity('erin');
await db.run(
  `INSERT INTO players (userId, mu, sigma, wins, losses, draws, gamesPlayed, lastPlayed, preDecaySigma)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ['floor', 25.0, 8.333, 0, 1, 0, 1, new Date().toISOString(), 8.333]
);
recordPlayerActivity('floor');

assertEqual((await playerState('erin')).elo, 1388, 'baseline Elo before any timewalk');
assertEqual((await playerState('floor')).elo, 1000, 'below-cutoff player baseline');

// --- /timewalk +8: virtual day 8, 2 days past the 6-day grace -> 1388 - 2 = 1386
await timewalk(8);
assertEqual((await playerState('erin')).elo, 1386, 'after +8 days (2 past grace)');

// --- /timewalk +1: virtual day 9, 3 total days past grace -> must decay exactly
// 1 more Elo to 1385. Under the bug this run was skipped entirely.
const secondRunCount = await timewalk(1);
assertEqual(secondRunCount, 1, 'second timewalk reports 1 decayed player');
assertEqual((await playerState('erin')).elo, 1385, 'after +1 day (3 past grace) — exactly 1 more Elo');

// --- /timewalk +3: virtual day 12, 6 total days past grace -> 1388 - 6 = 1382.
// Under the bug this only reached 1385.
await timewalk(3);
const finalState = await playerState('erin');
assertEqual(finalState.elo, 1382, 'after +3 days (6 past grace)');

// Decay must be sigma-only: mu (estimated skill) is preserved throughout.
assertEqual(finalState.mu, 27.5, 'mu unchanged by decay');

// The below-cutoff player must be untouched by every timewalk (and never
// counted — the earlier "1 decayed player" assertion already covers that).
assertEqual((await playerState('floor')).elo, 1000, 'below-cutoff player never decays');

await closeDatabase();
process.chdir(originalCwd); // can't rmSync the process's own cwd on Windows
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll assertions passed');
