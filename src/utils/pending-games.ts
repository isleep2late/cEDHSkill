import type { ButtonInteraction } from 'discord.js';
import { logger } from './logger.js';

/**
 * In-memory registry of games awaiting button confirmation.
 *
 * rank.ts registers a pending game when it posts a confirmation message; the
 * global button router (utils/button-handlers.ts) looks games up here to apply
 * confirm/cancel/turn-order clicks. Entries are removed on confirmation,
 * cancellation, or expiry. Like the old reaction collectors, this state is
 * process-local: a restart clears it (pending games are already archived by
 * the ghost-game startup cleanup, and buttons on dead messages answer with an
 * ephemeral "no longer active" notice). Turn-order buttons on CONFIRMED games
 * do not use this registry at all — they work off the database and therefore
 * survive restarts.
 */

export interface PendingPlayerGame {
  kind: 'player';
  gameId: string;
  messageId: string;
  submitterId: string;
  /** All participant user IDs (including the submitter if they play). */
  playerIds: string[];
  /** Players who still need to press Confirm. */
  pending: Set<string>;
  /** Current turn-order claims: userId -> turn number (seeded from inline input). */
  assignments: Map<string, number>;
  /** Guards against double-processing when the final confirm lands twice. */
  processing: boolean;
  /** Builds the current content/embed/components for the confirmation message. */
  renderPending: () => { content: string; embeds: any[]; components: any[] };
  /** Runs the game. pushedThroughBy is set when an admin supplied the final confirmation. */
  complete: (via: ButtonInteraction, pushedThroughBy?: string) => Promise<void>;
  cancel: (via: ButtonInteraction) => Promise<void>;
  expireTimer?: NodeJS.Timeout;
}

export interface PendingDeckGame {
  kind: 'deck';
  gameId: string;
  messageId: string;
  submitterId: string;
  /** Any users may confirm deck games; this tracks who has. */
  confirmations: Set<string>;
  required: number;
  processing: boolean;
  renderPending: () => { content: string; embeds: any[]; components: any[] };
  complete: (via: ButtonInteraction) => Promise<void>;
  cancel: (via: ButtonInteraction) => Promise<void>;
  expireTimer?: NodeJS.Timeout;
}

export type PendingGame = PendingPlayerGame | PendingDeckGame;

const pendingGames = new Map<string, PendingGame>();

export function registerPendingGame(game: PendingGame, ttlMs: number, onExpire: () => Promise<void>): void {
  game.expireTimer = setTimeout(async () => {
    pendingGames.delete(game.gameId);
    try {
      await onExpire();
    } catch (error) {
      logger.error(`[PENDING] Error expiring pending game ${game.gameId}:`, error);
    }
  }, ttlMs);
  pendingGames.set(game.gameId, game);
}

export function getPendingGame(gameId: string): PendingGame | undefined {
  return pendingGames.get(gameId);
}

export function removePendingGame(gameId: string): void {
  const game = pendingGames.get(gameId);
  if (game) {
    if (game.expireTimer) clearTimeout(game.expireTimer);
    pendingGames.delete(gameId);
  }
}
