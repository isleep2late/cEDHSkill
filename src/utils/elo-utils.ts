export function calculateElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}