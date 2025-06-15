// src/utils/snapshot-utils.ts

export interface PlayerSnapshot {
  userId: string;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
  draws: number;
  tag: string;
}

export interface MatchSnapshot {
  matchId: string;
  before: PlayerSnapshot[];
  after: PlayerSnapshot[];
}

// Stack to store history of snapshots
const rankOpHistoryStack: MatchSnapshot[] = [];
const undoneStack: MatchSnapshot[] = [];

export function saveMatchSnapshot(snapshot: MatchSnapshot) {
  rankOpHistoryStack.push(snapshot);
  undoneStack.length = 0; // Clear redo stack
}

export function undoLastMatch(): MatchSnapshot | null {
  if (rankOpHistoryStack.length === 0) return null;
  const snapshot = rankOpHistoryStack.pop()!;
  undoneStack.push(snapshot);
  return snapshot;
}

export function redoLastMatch(): MatchSnapshot | null {
  if (undoneStack.length === 0) return null;
  const snapshot = undoneStack.pop()!;
  rankOpHistoryStack.push(snapshot);
  return snapshot;
}

export function calculateElo(mu: number, sigma: number): number {
  const baseElo = 1000;
  const eloFromMu = (mu - 25) * 12;
  const sigmaPenalty = (sigma - 8.333) * 4;
  return Math.round(baseElo + eloFromMu - sigmaPenalty);
}

export function getPlayerSnapshotDiffs(before: PlayerSnapshot[], after: PlayerSnapshot[]) {
  return before.map((b) => {
    const a = after.find((p) => p.userId === b.userId) ?? b;
    return {
      tag: b.tag,
      beforeElo: calculateElo(b.mu, b.sigma).toFixed(2),
      afterElo: calculateElo(a.mu, a.sigma).toFixed(2),
      beforeMu: b.mu.toFixed(2),
      afterMu: a.mu.toFixed(2),
      beforeSigma: b.sigma.toFixed(2),
      afterSigma: a.sigma.toFixed(2),
      beforeW: b.wins,
      afterW: a.wins,
      beforeL: b.losses,
      afterL: a.losses,
      beforeD: b.draws,
      afterD: a.draws,
    };
  });
}
