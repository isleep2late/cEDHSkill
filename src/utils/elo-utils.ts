export function calculateElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}

/**
 * Calculate the mu value needed to achieve a target Elo given a sigma value.
 * Elo = 1000 + (mu - 25) * 12 - (sigma - 8.333) * 4
 * Solving for mu: mu = 25 + (Elo - 1000 + (sigma - 8.333) * 4) / 12
 */
export function muFromElo(targetElo: number, sigma: number): number {
  const sigmaPenalty = (sigma - 8.333) * 4;
  return ((targetElo - 1000 + sigmaPenalty) / 12) + 25;
}

/**
 * Calculate the sigma value needed to achieve a target Elo given a fixed mu.
 * Used by the decay system: decay increases sigma (uncertainty) rather than
 * decreasing mu (skill), so a player's actual skill estimate is preserved
 * while their displayed Elo drops due to increased uncertainty.
 *
 * Elo = 1000 + (mu - 25) * 12 - (sigma - 8.333) * 4
 * Solving for sigma: sigma = 8.333 + (1000 + (mu - 25) * 12 - Elo) / 4
 */
export function sigmaFromElo(targetElo: number, mu: number): number {
  const eloFromMu = (mu - 25) * 12;
  return 8.333 + (1000 + eloFromMu - targetElo) / 4;
}

/**
 * Calculate mu and sigma adjustments to achieve exactly a target Elo change.
 * Returns new mu/sigma values that result in the desired Elo change.
 * Adjusts mu while keeping sigma stable (used for participation bonuses).
 */
export function adjustRatingForEloChange(
  currentMu: number,
  currentSigma: number,
  eloChange: number
): { mu: number; sigma: number } {
  const currentElo = calculateElo(currentMu, currentSigma);
  const targetElo = currentElo + eloChange;

  const newMu = muFromElo(targetElo, currentSigma);

  return { mu: newMu, sigma: currentSigma };
}