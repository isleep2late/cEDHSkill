// src/jobs/decay.ts
import { getAllPlayers, updatePlayerRating } from '../db/player-utils.js';
import cron                                  from 'node-cron';

const DECAY_RATE_PER_RUN = 0.005;            // ~0.5% “rate” per invocation
const RUN_INTERVAL_MS    = 24 * 60 * 60 * 1000;    // 1 day between runs
const GRACE_RUNS         = 8;                // must miss last 8 runs before decaying
const GRACE_PERIOD_MS    = RUN_INTERVAL_MS * GRACE_RUNS;
const ELO_CUTOFF         = 1200;             // only decay players >=1200 Elo
const MAX_SIGMA          = 10;
const BASE_ELO           = 1000;
const MU_SCALE           = 12;
const SIGMA_BASE         = 8.333;
const SIGMA_SCALE        = 4;

// Convert mu/sigma into Elo exactly as in rank.ts:
function eloFromMuSigma(mu: number, sigma: number): number {
  const eloFromMu    = (mu - 25) * MU_SCALE;
  const sigmaPenalty =      (sigma - SIGMA_BASE) * SIGMA_SCALE;
  return Math.round(BASE_ELO + eloFromMu - sigmaPenalty);
}

// Inverse Elo → μ for clamping at cutoff
function muFromElo(targetElo: number, sigma: number): number {
  const sigmaPenalty = (sigma - SIGMA_BASE) * SIGMA_SCALE;
  return ((targetElo - BASE_ELO + sigmaPenalty) / MU_SCALE) + 25;
}

export async function applyRatingDecay(): Promise<void> {
  const now     = Date.now();
  const players = await getAllPlayers();

  for (const p of players) {
    // 1) skip anyone who hasn't played any games
    if (p.gamesPlayed === 0) {
      console.log(`[DECAY][SKIP] ${p.userId} – no games played`);
      continue;
    }

    // 2) skip anyone who played within the last 2 runs
    if (!p.lastPlayed) {
      console.log(`[DECAY][SKIP] ${p.userId} – no lastPlayed timestamp`);
      continue;
    }
    const msSinceLast = now - new Date(p.lastPlayed).getTime();
    if (msSinceLast < GRACE_PERIOD_MS) {
      console.log(
        `[DECAY][SKIP] ${p.userId} – lastPlayed ${Math.floor(msSinceLast/1000)}s ago (< ${GRACE_PERIOD_MS/1000}s)`
      );
      continue;
    }

    // 3) skip anyone under the Elo cutoff
    const currentElo = eloFromMuSigma(p.mu, p.sigma);
    if (currentElo < ELO_CUTOFF) {
      console.log(
        `[DECAY][SKIP] ${p.userId} – Elo ${Math.round(currentElo)} < cutoff ${ELO_CUTOFF}`
      );
      continue;
    }

    // 4) saturating‐exponential increase on σ
    const sigmaInc = (MAX_SIGMA - p.sigma) * (1 - Math.exp(-DECAY_RATE_PER_RUN));
    const newSigma = Math.min(p.sigma + sigmaInc, MAX_SIGMA);

    // 5) compute μ target to hit cutoff at new σ
    const muClamp = muFromElo(ELO_CUTOFF, newSigma);

    // 6) saturating‐exponential decay on μ toward clamp
    const newMu = muClamp + (p.mu - muClamp) * Math.exp(-DECAY_RATE_PER_RUN);

    console.log(
      `[DECAY][RUN] ${p.userId}` +
      ` μ: ${p.mu.toFixed(2)}→${newMu.toFixed(2)}` +
      ` σ: ${p.sigma.toFixed(2)}→${newSigma.toFixed(2)}` +
      ` (Elo: ${currentElo}→${eloFromMuSigma(newMu,newSigma)})`
    );

    // 7) apply the update (this also bumps lastPlayed to now)
    await updatePlayerRating(
      p.userId,
      newMu,
      newSigma,
      p.wins,
      p.losses,
      p.draws
    );
  }
}

// initial run
applyRatingDecay().catch(console.error);

// schedule every minute
cron.schedule('0 0 * * *', () => {
  console.log('[DECAY] scheduled run');
  applyRatingDecay().catch(console.error);
});
