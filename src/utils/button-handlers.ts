import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';
import { getDatabase } from '../db/init.js';
import { setPlayerTurnOrderForGame } from '../db/match-utils.js';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  getPendingGame,
  PendingDeckGame,
  PendingPlayerGame
} from './pending-games.js';

/**
 * Button-based game confirmation and turn-order tracking.
 *
 * All buttons use customIds of the form `cedh:<action>:<gameId>[:<turn>]` and
 * are routed here from bot.ts's InteractionCreate handler. Pending games are
 * resolved via the in-memory registry (utils/pending-games.ts); turn-order
 * clicks on already-confirmed games are resolved against the database, so
 * they keep working indefinitely — including after bot restarts.
 */

function hasModAccess(userId: string): boolean {
  return config.admins.includes(userId) || config.moderators.includes(userId);
}

export function buildConfirmRow(gameId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cedh:confirm:${gameId}`)
      .setLabel('Confirm')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cedh:cancel:${gameId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );
}

export function buildTurnRow(gameId: string, playerCount: number): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const count = Math.min(Math.max(playerCount, 1), 4);
  for (let turn = 1; turn <= count; turn++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`cedh:turn:${gameId}:${turn}`)
        .setLabel(`Turn ${turn}`)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}

export async function handleGameButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, gameId, turnPart] = interaction.customId.split(':');
  const parsedTurn = turnPart ? parseInt(turnPart, 10) : NaN;
  const turnNumber = Number.isInteger(parsedTurn) && parsedTurn >= 1 ? parsedTurn : null;
  if (!action || !gameId || (action === 'turn' && turnNumber === null)) {
    await interaction.reply({ content: '⚠️ Unrecognized button.', ephemeral: true }).catch(() => {});
    return;
  }

  const pending = getPendingGame(gameId);
  if (pending) {
    if (pending.kind === 'player') {
      await handlePendingPlayerButton(interaction, pending, action, turnNumber);
    } else {
      await handlePendingDeckButton(interaction, pending, action);
    }
    return;
  }

  // No pending state: either the game is already confirmed (turn buttons keep
  // working via the database) or the pending game died (expired, cancelled,
  // snapped, or lost to a restart).
  if (action === 'turn' && turnNumber) {
    await handleConfirmedGameTurnButton(interaction, gameId, turnNumber);
    return;
  }

  const db = getDatabase();
  const gm = await db.get('SELECT status FROM games_master WHERE gameId = ?', gameId);
  if (gm?.status === 'confirmed') {
    await interaction.reply({
      content: `✅ Game ${gameId} has already been confirmed and processed.`,
      ephemeral: true
    });
  } else {
    await interaction.reply({
      content: `⚠️ This pending game is no longer active — it expired, was cancelled, or the bot restarted before it was confirmed.`,
      ephemeral: true
    });
  }
}

async function handlePendingPlayerButton(
  interaction: ButtonInteraction,
  game: PendingPlayerGame,
  action: string,
  turnNumber: number | null
): Promise<void> {
  const userId = interaction.user.id;

  if (action === 'cancel') {
    if (userId !== game.submitterId) {
      await interaction.reply({ content: '⚠️ Only the game submitter can cancel this game.', ephemeral: true });
      return;
    }
    if (game.processing) {
      await interaction.reply({ content: '⏳ This game is already being processed.', ephemeral: true });
      return;
    }
    game.processing = true;
    await game.cancel(interaction);
    return;
  }

  if (action === 'confirm') {
    if (game.processing) {
      await interaction.reply({ content: '⏳ This game is already being processed.', ephemeral: true });
      return;
    }

    if (game.pending.has(userId)) {
      game.pending.delete(userId);
      if (game.pending.size === 0) {
        game.processing = true;
        await game.complete(interaction);
      } else {
        await interaction.update(game.renderPending());
      }
      return;
    }

    // Admin/moderator push-through: supplies the final missing confirmation.
    // Checked BEFORE the "already confirmed" branch so an admin who is also a
    // player (and has already confirmed) can still push the game through.
    if (hasModAccess(userId) && game.pending.size === 1) {
      game.pending.clear();
      game.processing = true;
      await game.complete(interaction, userId);
      return;
    }

    if (game.playerIds.includes(userId)) {
      const modHint = hasModAccess(userId)
        ? ' As an admin/moderator you can push the game through once only 1 confirmation remains.'
        : '';
      await interaction.reply({ content: `✅ You have already confirmed this game.${modHint}`, ephemeral: true });
      return;
    }

    if (hasModAccess(userId)) {
      await interaction.reply({
        content:
          `⚠️ Still waiting on ${game.pending.size} player confirmations. ` +
          `An admin or moderator can push the game through once only 1 confirmation remains.`,
        ephemeral: true
      });
      return;
    }

    await interaction.reply({ content: '⚠️ Only players in this game can confirm it.', ephemeral: true });
    return;
  }

  if (action === 'turn' && turnNumber) {
    if (game.processing) {
      // The game is being finalized: the in-memory assignments have already
      // been copied into the game record, so a claim here would be silently
      // lost. Once processing finishes the turn buttons work via the database.
      await interaction.reply({
        content: '⏳ This game is being finalized — click the turn button again in a moment.',
        ephemeral: true
      });
      return;
    }
    if (!game.playerIds.includes(userId)) {
      await interaction.reply({ content: '⚠️ Only players in this game can set turn order.', ephemeral: true });
      return;
    }

    const current = game.assignments.get(userId);
    if (current === turnNumber) {
      // Clicking your own turn again rescinds it.
      game.assignments.delete(userId);
      await interaction.update(game.renderPending());
      return;
    }
    if (current !== undefined) {
      await interaction.reply({
        content: `⚠️ You already have Turn ${current}. Click "Turn ${current}" again to rescind it before choosing another.`,
        ephemeral: true
      });
      return;
    }

    // Overthrow: claiming a turn held by another player takes it from them.
    let previousHolder: string | null = null;
    for (const [otherId, order] of game.assignments) {
      if (order === turnNumber && otherId !== userId) {
        previousHolder = otherId;
        game.assignments.delete(otherId);
      }
    }
    game.assignments.set(userId, turnNumber);
    await interaction.update(game.renderPending());
    if (previousHolder) {
      await interaction.followUp({
        content: `🔄 You took Turn ${turnNumber} from <@${previousHolder}>.`,
        ephemeral: true
      }).catch(() => {});
    }
    return;
  }

  await interaction.reply({ content: '⚠️ Unrecognized button.', ephemeral: true }).catch(() => {});
}

async function handlePendingDeckButton(
  interaction: ButtonInteraction,
  game: PendingDeckGame,
  action: string
): Promise<void> {
  const userId = interaction.user.id;

  if (action === 'cancel') {
    if (userId !== game.submitterId) {
      await interaction.reply({ content: '⚠️ Only the game submitter can cancel this deck battle.', ephemeral: true });
      return;
    }
    if (game.processing) {
      await interaction.reply({ content: '⏳ This deck battle is already being processed.', ephemeral: true });
      return;
    }
    game.processing = true;
    await game.cancel(interaction);
    return;
  }

  if (action === 'confirm') {
    if (game.processing) {
      await interaction.reply({ content: '⏳ This deck battle is already being processed.', ephemeral: true });
      return;
    }
    if (game.confirmations.has(userId)) {
      await interaction.reply({ content: '✅ You have already confirmed this deck battle.', ephemeral: true });
      return;
    }
    game.confirmations.add(userId);
    if (game.confirmations.size >= game.required) {
      game.processing = true;
      await game.complete(interaction);
    } else {
      await interaction.update(game.renderPending());
    }
    return;
  }

  await interaction.reply({ content: '⚠️ This button does not apply to deck battles.', ephemeral: true }).catch(() => {});
}

/**
 * Turn-order clicks on games that are already confirmed. Backed entirely by
 * the database so the buttons work forever, across restarts, exactly as the
 * user-facing rules promise: one turn per player, click again to rescind,
 * claiming a taken turn overthrows the current holder.
 *
 * Clicks are acknowledged immediately (deferUpdate) and then serialized per
 * game, so two players racing for the same turn cannot both claim it.
 */
const turnClickQueues = new Map<string, Promise<void>>();

function enqueueTurnClick(gameId: string, task: () => Promise<void>): Promise<void> {
  const tail = turnClickQueues.get(gameId) ?? Promise.resolve();
  const next = tail.then(task, task);
  turnClickQueues.set(gameId, next);
  next.finally(() => {
    if (turnClickQueues.get(gameId) === next) turnClickQueues.delete(gameId);
  });
  return next;
}

async function handleConfirmedGameTurnButton(
  interaction: ButtonInteraction,
  gameId: string,
  turnNumber: number
): Promise<void> {
  // Ack within the ~3s deadline before doing any DB or REST work.
  try {
    await interaction.deferUpdate();
  } catch {
    return; // Interaction expired or already acknowledged elsewhere
  }
  await enqueueTurnClick(gameId, async () => {
    try {
      await processConfirmedTurnClick(interaction, gameId, turnNumber);
    } catch (error) {
      logger.error(`Error processing turn-order click for game ${gameId}:`, error);
    }
  });
}

async function processConfirmedTurnClick(
  interaction: ButtonInteraction,
  gameId: string,
  turnNumber: number
): Promise<void> {
  const db = getDatabase();
  const userId = interaction.user.id;
  const ephemeral = (content: string) =>
    interaction.followUp({ content, ephemeral: true }).catch(() => {});

  const gm = await db.get('SELECT gameType, status, active FROM games_master WHERE gameId = ?', gameId);
  if (!gm) {
    await ephemeral('⚠️ This game no longer exists — it expired, was cancelled, or was removed.');
    return;
  }
  if (gm.status === 'pending') {
    await ephemeral('⚠️ This game was still awaiting confirmation when the bot restarted, so it can no longer be confirmed — please resubmit it.');
    return;
  }
  if (gm.gameType !== 'player' || gm.status !== 'confirmed' || !gm.active) {
    await ephemeral('⚠️ Turn order can only be changed on active, confirmed player games.');
    return;
  }

  const rows = await db.all('SELECT userId, turnOrder FROM matches WHERE gameId = ?', gameId);
  const me = rows.find((r: any) => r.userId === userId);
  if (!me) {
    await ephemeral('⚠️ Only players in this game can set turn order.');
    return;
  }
  if (turnNumber < 1 || turnNumber > rows.length) {
    await ephemeral(`⚠️ Turn ${turnNumber} is not valid for this game.`);
    return;
  }

  let previousHolder: string | null = null;
  if (me.turnOrder === turnNumber) {
    // Clicking your own turn again rescinds it.
    await setPlayerTurnOrderForGame(gameId, userId, null);
  } else if (me.turnOrder != null) {
    await ephemeral(`⚠️ You already have Turn ${me.turnOrder}. Click "Turn ${me.turnOrder}" again to rescind it before choosing another.`);
    return;
  } else {
    // Overthrow: claiming a turn held by another player takes it from them.
    const holder = rows.find((r: any) => r.userId !== userId && r.turnOrder === turnNumber);
    if (holder) {
      previousHolder = holder.userId;
      await setPlayerTurnOrderForGame(gameId, holder.userId, null);
    }
    await setPlayerTurnOrderForGame(gameId, userId, turnNumber);
  }

  // Refresh the message footer with the latest assignments.
  const updated = await db.all(
    'SELECT userId, turnOrder FROM matches WHERE gameId = ? AND turnOrder IS NOT NULL ORDER BY turnOrder',
    gameId
  );
  const names: string[] = [];
  for (const row of updated) {
    const user = await interaction.client.users.fetch(row.userId).catch(() => null);
    names.push(`Turn ${row.turnOrder}: ${user?.username ?? row.userId}`);
  }
  const footerText = names.length > 0
    ? `Turn orders: ${names.join(' • ')}`
    : 'Turn orders: none recorded yet';

  try {
    const embeds = interaction.message.embeds;
    if (embeds.length > 0) {
      const refreshed = EmbedBuilder.from(embeds[0]).setFooter({ text: footerText });
      await interaction.editReply({ embeds: [refreshed, ...embeds.slice(1).map(e => EmbedBuilder.from(e))] });
    }
  } catch (error) {
    logger.error(`Failed to refresh turn-order display for game ${gameId}:`, error);
  }

  if (previousHolder) {
    await ephemeral(`🔄 You took Turn ${turnNumber} from <@${previousHolder}>.`);
  }
}
