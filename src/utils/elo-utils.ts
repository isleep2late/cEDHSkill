export function calculateElo(mu: number, sigma: number): number {
  return Math.round(1000 + 25 * (mu - 3 * sigma));
}

/**
 * Calculate the mu value needed to achieve a target Elo given a sigma value.
 * Elo = 1000 + 25 * (mu - 3 * sigma)
 * Solving for mu: mu = (Elo - 1000) / 25 + 3 * sigma
 */
export function muFromElo(targetElo: number, sigma: number): number {
  return 3 * sigma + targetElo / 25 - 40;
}

/**
 * Calculate the sigma value needed to achieve a target Elo given a fixed mu.
 * Used by the decay system: decay increases sigma (uncertainty) rather than
 * decreasing mu (skill), so a player's actual skill estimate is preserved
 * while their displayed Elo drops due to increased uncertainty.
 *
 * Elo = 1000 + 25 * (mu - 3 * sigma)
 * Solving for sigma: sigma = (1000 + 25 * mu - Elo) / 75
 */
export function sigmaFromElo(targetElo: number, mu: number): number {
  return ((mu + 40) - (targetElo / 25)) / 3;
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
