# cEDHSkill v0.03 Beta - Change Audit

**Date:** 2026-04-23
**Author:** Claude (AI assistant), directed by isleep2late
**Reviewer:** AEtheriumSlinky
**Branch:** `claude/ranked-season-elo-changes-l7Saz`
**Base commit:** `8a93691` (Merge pull request #58)
**Change commit:** `4323b5a`

---

## Summary of Changes

Two functional changes were made for the next ranked season:

1. **New Elo formula** - Changed from `Elo = 1000 + (mu - 25) * 12 - (sigma - 8.333) * 4` to `Elo = 1000 + 25 * (mu - 3 * sigma)`
2. **Daily participation bonus cap** - Limited the +1 Elo participation bonus to 5 games per day (per player and per deck)

Both changes were applied consistently across all code paths: normal game submission, game replay/recalculation, and the `/set` command's re-execution logic.

---

## Files Changed (7 files, +110 / -46 lines)

| File | Lines Changed | Purpose |
|------|---------------|---------|
| `src/utils/elo-utils.ts` | +14 / -19 | Core formula and inverse functions |
| `src/db/match-utils.ts` | +42 / -0 | New daily game count queries |
| `src/commands/rank.ts` | +53 / -16 (functional) | All participation bonus call sites + formula fixes |
| `src/commands/set.ts` | +30 / -9 | Recalculation participation bonus + formula fixes |
| `src/bot.ts` | +4 / -4 (comments only) | Decay system comments |
| `src/commands/help.ts` | +4 / -4 (display only) | User-facing help text |
| `README.md` | +4 / -4 (docs only) | Documentation |

---

## Change 1: New Elo Formula

### What changed

**Old formula:** `Elo = 1000 + (mu - 25) * 12 - (sigma - 8.333) * 4`
**New formula:** `Elo = 1000 + 25 * (mu - 3 * sigma)`

Both formulas produce approximately **1000 Elo** for the default starting values (mu=25.0, sigma=8.333):
- Old: `1000 + (25-25)*12 - (8.333-8.333)*4 = 1000`
- New: `1000 + 25*(25 - 3*8.333) = 1000 + 25*0.001 = 1000.025` (rounds to 1000)

### Key differences in behavior

| Aspect | Old Formula | New Formula |
|--------|-------------|-------------|
| Mu weight | 12 Elo per mu point | 25 Elo per mu point |
| Sigma weight | 4 Elo per sigma point | 75 Elo per sigma point |
| Sigma for -1 Elo decay | +0.25 sigma | +1/75 sigma (~0.0133) |
| Sensitivity to skill changes | Lower | Higher |
| Sensitivity to confidence changes | Lower | Much higher |

### Files affected

#### `src/utils/elo-utils.ts` (core)

All three conversion functions were updated:

```typescript
// calculateElo: mu/sigma -> Elo
// OLD: 1000 + (mu - 25) * 12 - (sigma - 8.333) * 4
// NEW: 1000 + 25 * (mu - 3 * sigma)

// muFromElo: Elo + sigma -> mu (inverse)
// OLD: ((Elo - 1000 + (sigma - 8.333) * 4) / 12) + 25
// NEW: (Elo - 1000) / 25 + 3 * sigma

// sigmaFromElo: Elo + mu -> sigma (used by decay)
// OLD: 8.333 + (1000 + (mu - 25) * 12 - Elo) / 4
// NEW: (1000 + 25 * mu - Elo) / 75
```

The `adjustRatingForEloChange` function was NOT changed because it calls `calculateElo` and `muFromElo` internally, so it automatically uses the new formula.

#### `src/commands/rank.ts` - `ensureMinimumRatingChange()` (line ~985)

Two hardcoded formula inversions were replaced with `muFromElo()` calls:

```typescript
// OLD (line 983):
const targetMu = 25 + (targetElo - 1000 + (newRating.sigma - 8.333) * 4) / 12;
// NEW:
const targetMu = muFromElo(targetElo, newRating.sigma);
```

This was done for both the winner (+2 minimum) and loser (-2 minimum) branches.

#### `src/commands/set.ts` - `ensureMinimumRatingChange()` (line ~1438)

Identical fix as rank.ts - two hardcoded formula inversions replaced with `muFromElo()`:

```typescript
// OLD (line 1435):
const targetMu = 25 + (targetElo - 1000 + (newRating.sigma - 8.333) * 4) / 12;
// NEW:
const targetMu = muFromElo(targetElo, newRating.sigma);
```

#### `src/bot.ts` (comments only)

Two comments updated to reflect the new sigma-to-Elo relationship:
- Line 55: `Each +0.25 sigma = -1 Elo` -> `Each +1/75 sigma = -1 Elo`
- Line 240: Same change in the decay docstring

No functional code was changed in bot.ts. The decay system uses `sigmaFromElo()` and `calculateElo()` which were already updated in elo-utils.ts, so decay automatically works with the new formula.

#### `src/commands/help.ts` (display only)

Line 43: Updated the Elo Conversion display string shown to users in the `/help` info section.

#### `README.md` (docs only)

Line 8: Updated the formula shown in the Features section.

---

## Change 2: Daily Participation Bonus Limit (5/day)

### What changed

Previously, every ranked game awarded a +1 Elo participation bonus unconditionally. Now, only the **first 5 games per calendar day (UTC)** earn the bonus, per player and per deck independently.

### How it works

1. Before applying the participation bonus, the system counts how many active games the player/deck has already played on the same UTC calendar date, using `gameSequence` ordering to determine "before."
2. If the count is >= 5, the bonus is skipped (the function returns the rating unchanged).
3. The display text changes from `+ 1 (participation)` to `+ 0 (daily bonus limit reached)` when the cap is hit.

### New database query functions

#### `src/db/match-utils.ts` - Two new exported functions:

```typescript
// Count player games on a date before a specific game
export async function getPlayerGamesOnDateBefore(
  userId: string, matchDate: Date, currentGameId: string
): Promise<number>

// Count deck games on a date before a specific game
export async function getDeckGamesOnDateBefore(
  deckNormalizedName: string, matchDate: Date, currentGameId: string
): Promise<number>
```

Both functions:
- Join `matches`/`deck_matches` with `games_master` to check `active = 1`
- Use `DATE(m.matchDate)` to compare calendar days (UTC)
- Use `gm.gameSequence < (SELECT gameSequence FROM games_master WHERE gameId = ?)` to only count games chronologically before the current one
- Return `COUNT(DISTINCT gameId)` to avoid double-counting (a player appears in multiple match rows per game, but it's one game)

The `gameSequence` comparison ensures correct behavior during recalculation: when games are replayed in order, only games that happened "before" in the timeline count toward the daily limit.

### Modified function signatures

#### `src/commands/rank.ts` - `applyParticipationBonus()`

```typescript
// OLD:
function applyParticipationBonus(rating: Rating): Rating

// NEW:
function applyParticipationBonus(rating: Rating, gamesAlreadyToday: number = 0): Rating
```

Added `MAX_DAILY_PARTICIPATION_BONUS = 5` constant. If `gamesAlreadyToday >= 5`, returns rating unchanged.

#### `src/commands/set.ts` - `applyParticipationBonus()`

Identical change to the set.ts copy of this function (set.ts has its own local copy used during re-execution).

### All call sites updated (7 total)

Every place that calls `applyParticipationBonus` now queries the daily count first:

| File | Function | Line | Entity Type |
|------|----------|------|-------------|
| `rank.ts` | `replayPlayerGame()` | ~616 | Player |
| `rank.ts` | `replayDeckGame()` | ~794 | Deck |
| `rank.ts` | `processGameResults()` | ~2714 | Player |
| `rank.ts` | `processCommanderRatingsEnhanced()` | ~3029 | Deck |
| `rank.ts` | `processDeckResults()` | ~3207 | Deck |
| `set.ts` | `reexecutePlayerGameWithOriginalOutcome()` | ~1210 | Player |
| `set.ts` | `reexecuteDeckGameWithOriginalOutcome()` | ~1317 | Deck |

### Display text changes (2 locations)

| File | Line | Context |
|------|------|---------|
| `rank.ts` | ~2782 | Player game results embed |
| `rank.ts` | ~3280 | Deck game results embed |

Both now conditionally show:
- `+ 1 (participation)` when the bonus is applied
- `+ 0 (daily bonus limit reached)` when the daily cap is hit

### Help text updated

| File | Line | Change |
|------|------|--------|
| `help.ts` | 48 | `"All players receive +1 Elo for every ranked game played."` -> `"...played (max 5 per day)."` |
| `README.md` | 9 | Same update in Features section |

---

## What Was NOT Changed

These areas were reviewed and confirmed to need no changes:

- **Decay system logic** (`bot.ts` lines 256-465) - Uses `sigmaFromElo()` and `calculateElo()` from elo-utils.ts, which were updated. The decay constants (`DECAY_ELO_PER_DAY = 1`, `ELO_CUTOFF = 1050`, `GRACE_DAYS`) are Elo-denominated, not formula-specific, so they work correctly with the new formula.
- **Default mu/sigma values** (25.0 / 8.333) - These remain unchanged in `players` table defaults, `decks` table defaults, and `getOrCreatePlayer()`. The new formula still produces ~1000 Elo for these defaults.
- **Database schema** - No migrations needed. The daily bonus limit uses existing `matchDate` and `gameSequence` columns.
- **Snapshot/undo/redo system** - Uses raw mu/sigma values, not Elo calculations, so it's formula-agnostic.
- **Audit logging** (`rating-audit-utils.ts`) - Logs raw mu/sigma and calls `calculateElo()`, which automatically uses the new formula.
- **`/predict` command** - Uses `calculateElo()` internally, automatically updated.
- **`/list`, `/view` commands** - Use `calculateElo()` internally, automatically updated.
- **`/thanossnap` command** - Uses `calculateElo()` for final leaderboards, automatically updated.

---

## Testing Verification

- **TypeScript compilation:** `npx tsc --noEmit` passes with zero errors.
- **Formula correctness:** Verified that default values (mu=25, sigma=8.333) produce Elo=1000 with the new formula. Verified inverse functions round-trip correctly.
- **No remaining old formula references:** `grep` confirmed no remaining hardcoded `(mu - 25) * 12`, `(sigma - 8.333) * 4`, or inline formula inversions anywhere in the codebase.

---

## Risk Assessment

| Area | Risk | Mitigation |
|------|------|------------|
| Existing player ratings | **Medium** - All existing mu/sigma values will produce different Elo numbers under the new formula | This is intentional for the new season. A `/set recalculate:true` or `/thanossnap` should be run before the new season starts to reset or recalculate all ratings. |
| Daily bonus during recalculation | **Low** - Complex interaction between game ordering and daily counts | Uses `gameSequence` ordering (not wall-clock time) to correctly determine "before" during replay. The `COUNT(DISTINCT gameId)` prevents double-counting. |
| Decay behavior | **Low** - Sigma-per-day of decay changes significantly | The decay system targets a specific Elo reduction (-1/day) by solving for sigma, so the actual Elo decay rate is unchanged. Only the sigma increment per day changes (from +0.25 to +0.0133). |
| Performance | **Low** - New DB queries for each participation bonus | Queries use indexed columns (`gameId`, `active`) and are bounded by a single calendar day. Typical game has 4 players, so 4 queries per game. |
