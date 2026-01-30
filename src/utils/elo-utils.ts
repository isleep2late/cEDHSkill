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
 * Calculate mu and sigma adjustments to achieve exactly a target Elo change.
 * Returns new mu/sigma values that result in the desired Elo change.
 * For small changes, we primarily adjust mu since sigma changes have larger effects.
 */
export function adjustRatingForEloChange(
  currentMu: number,
  currentSigma: number,
  eloChange: number
): { mu: number; sigma: number } {
  const currentElo = calculateElo(currentMu, currentSigma);
  const targetElo = currentElo + eloChange;

  // For decay/bonus, we adjust mu while keeping sigma relatively stable
  // but slightly increasing sigma for decay (more uncertainty)
  // or keeping it same for bonus
  const newMu = muFromElo(targetElo, currentSigma);

  return { mu: newMu, sigma: currentSigma };
}