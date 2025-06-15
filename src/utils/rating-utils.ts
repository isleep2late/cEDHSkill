import { rate, Rating } from 'openskill';

export function applyMatchResults(teams: Rating[][]): Rating[][] {
  return rate(teams);
}

export function decayRating(rating: Rating, factor: number = 0.9): Rating {
  return {
    mu: rating.mu * factor,
    sigma: rating.sigma * factor
  };
}

export function toElo(rating: Rating): number {
  return Math.round((rating.mu - 25) * 20);
}

// Overload-style version to match call sites
export function calculateElo(rating: Rating): number;
export function calculateElo(mu: number, sigma: number): number;
export function calculateElo(arg1: Rating | number, arg2?: number): number {
  if (typeof arg1 === 'object') {
    return toElo(arg1);
  } else if (typeof arg1 === 'number' && typeof arg2 === 'number') {
    return Math.round((arg1 - 25) * 20);
  }
  throw new Error('Invalid arguments to calculateElo');
}
