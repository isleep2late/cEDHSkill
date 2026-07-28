/**
 * Integration test: turn-order button UX on a pending (non-admin) game.
 *
 * Guards against the trap that lost game BE4BF4 (2026-07-27): players clicked
 * Turn buttons believing that confirmed the game — a click on your own
 * already-assigned turn silently rescinded it, the embed body kept showing the
 * stale [Turn N], and no confirmations accrued, so the game expired. Asserts:
 *   1. rescind/claim send an ephemeral notice, with a "turn buttons do not
 *      confirm the game" reminder while the clicker's Confirm is outstanding
 *      (and without it once they have confirmed);
 *   2. the pending embed (description block, per-player fields, footer) is
 *      re-rendered from the LIVE assignments on every click;
 *   3. turn clicks never touch the pending-confirmation set;
 *   4. the confirmed game persists the final assignments (incl. auto-assign).
 *
 * Run with: npm test  (uses tsx; no Discord connection required)
 */

// Required by src/config.ts — must be set before any project module is imported.
process.env.DISCORD_TOKEN ??= 'test-token';
process.env.CLIENT_ID ??= 'test-client-id';
process.env.GUILD_ID ??= 'test-guild-id';
process.env.ADMINS = 'admin-user'; // none of the players, so the game stays non-admin

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

type Sent = { content?: string; embeds?: any[]; components?: any[] };

// Unwrap an EmbedBuilder (or raw embed) from a message payload.
function embedData(payload: Sent): { description: string; fields: { name: string; value: string }[]; footer?: { text: string } } {
  const e: any = payload.embeds![0];
  return e?.toJSON ? e.toJSON() : e?.data ?? e;
}

function fieldFor(payload: Sent, nameFragment: string): { name: string; value: string } {
  const field = embedData(payload).fields.find(f => f.name.includes(nameFragment));
  assert.ok(field, `expected an embed field for ${nameFragment}`);
  return field!;
}

async function main(): Promise<void> {
  // src/db/init.ts resolves data/cEDHSkill.db relative to the CWD at import time,
  // so switch to a temp dir before importing any project module.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cedhskill-turn-ux-'));
  process.chdir(tempDir);

  const { initDatabase, getDatabase, closeDatabase } = await import('../src/db/init.js');
  await initDatabase();
  const db = getDatabase();

  const { execute } = await import('../src/commands/rank.js');
  const { handleGameButton } = await import('../src/utils/button-handlers.js');
  const { getPendingGame } = await import('../src/utils/pending-games.js');

  // --- Stub Discord surface -------------------------------------------------
  const channelSends: Sent[] = [];
  const msgEdits: Sent[] = [];
  const replyMsg: any = {
    id: 'pending-msg-1',
    channel: { send: async (p: any) => { channelSends.push(p); return {}; } },
    edit: async (p: any) => { msgEdits.push(p); return replyMsg; },
  };
  const client: any = {
    user: { id: 'bot-user' },
    users: { fetch: async (id: string) => ({ id, username: `user-${id.slice(0, 3)}`, send: async () => {} }) },
    limboGames: new Map(),
  };

  // P0 wins from turn 3; P1/P2/P3 lose from turns 1/2/4 — all seeded inline.
  const P = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444'];
  const NAME = ['@user-111', '@user-222', '@user-333', '@user-444'];
  const results = `<@${P[0]}> w 3 <@${P[1]}> l 1 <@${P[2]}> l 2 <@${P[3]}> l 4`;

  const editReplies: Sent[] = [];
  const submitInteraction: any = {
    user: { id: P[0] },
    client,
    options: { getString: (name: string) => (name === 'results' ? results : null) },
    deferReply: async () => {},
    editReply: async (p: any) => { editReplies.push(p); return replyMsg; },
    followUp: async () => ({ delete: async () => {} }),
  };

  await execute(submitInteraction, client);

  const initial = editReplies.at(-1)!;
  const gameId = embedData(initial).description.match(/Game ID: ([0-9A-F]{6})/)?.[1];
  assert.ok(gameId, 'pending embed should contain the game ID');
  const game: any = getPendingGame(gameId!);
  assert.equal(game?.kind, 'player', 'game should be registered as pending');

  // Initial embed reflects the inline seeds.
  assert.match(embedData(initial).description, /Turn Order Assigned:/);
  assert.match(embedData(initial).description, new RegExp(`${NAME[0]}: Turn 3`));
  assert.match(fieldFor(initial, NAME[0]).name, /\[Turn 3\]/);

  function click(userId: string, customId: string) {
    const calls = { updates: [] as Sent[], followUps: [] as any[], replies: [] as any[] };
    const interaction: any = {
      user: { id: userId },
      customId,
      client,
      message: replyMsg,
      update: async (p: any) => { calls.updates.push(p); },
      followUp: async (p: any) => { calls.followUps.push(p); },
      reply: async (p: any) => { calls.replies.push(p); },
      deferUpdate: async () => {},
      editReply: async (p: any) => { msgEdits.push(p); return replyMsg; },
    };
    return handleGameButton(interaction).then(() => calls);
  }

  // --- 1. Rescind (unconfirmed): notice + reminder, embed body drops the turn
  let calls = await click(P[0], `cedh:turn:${gameId}:3`);
  assert.equal(calls.updates.length, 1, 'rescind should re-render the message');
  let rendered = calls.updates[0];
  assert.doesNotMatch(embedData(rendered).description, new RegExp(`${NAME[0]}: Turn 3`), 'description block must drop the rescinded turn');
  assert.doesNotMatch(fieldFor(rendered, NAME[0]).name, /\[Turn 3\]/, 'player field name must drop the stale [Turn 3]');
  assert.doesNotMatch(fieldFor(rendered, NAME[0]).value, /Turn Order: 3/, 'player field value must drop the stale turn order');
  assert.match(embedData(rendered).footer?.text ?? '', new RegExp(`${NAME[1]}: Turn 1`), 'footer keeps the other players');
  assert.doesNotMatch(embedData(rendered).footer?.text ?? '', new RegExp(NAME[0]), 'footer drops the rescinder');
  assert.equal(calls.followUps.length, 1, 'rescind must notify the clicker');
  assert.match(calls.followUps[0].content, /rescinded/i);
  assert.match(calls.followUps[0].content, /do \*\*not\*\* confirm/i, 'unconfirmed clicker gets the confirm reminder');
  assert.equal(calls.followUps[0].ephemeral, true);
  assert.equal(game.pending.size, 4, 'a turn click must never count as a confirmation');

  // --- 2. Claim (unconfirmed): recorded notice + reminder, embed body restored
  calls = await click(P[0], `cedh:turn:${gameId}:3`);
  rendered = calls.updates[0];
  assert.match(fieldFor(rendered, NAME[0]).name, /\[Turn 3\]/, 'reclaim restores the field display');
  assert.match(embedData(rendered).description, new RegExp(`${NAME[0]}: Turn 3`), 'reclaim restores the description block');
  assert.equal(calls.followUps.length, 1, 'unconfirmed claim must notify the clicker');
  assert.match(calls.followUps[0].content, /Turn 3 recorded/i);
  assert.match(calls.followUps[0].content, /do \*\*not\*\* confirm/i);
  assert.equal(game.pending.size, 4);

  // --- 3. Confirm P0, then rescind/claim again: notice without the reminder
  calls = await click(P[0], `cedh:confirm:${gameId}`);
  assert.equal(game.pending.size, 3, 'confirm click must count');
  calls = await click(P[0], `cedh:turn:${gameId}:3`);
  assert.equal(calls.followUps.length, 1);
  assert.match(calls.followUps[0].content, /rescinded/i);
  assert.doesNotMatch(calls.followUps[0].content, /do \*\*not\*\* confirm/i, 'confirmed clicker needs no reminder');
  calls = await click(P[0], `cedh:turn:${gameId}:3`);
  assert.equal(calls.followUps.length, 0, 'confirmed plain claim stays silent');

  // --- 4. Overthrow still notifies (with reminder for the unconfirmed taker)
  calls = await click(P[1], `cedh:turn:${gameId}:2`);
  assert.equal(calls.updates.length, 0, 'holding Turn 1, P1 cannot claim Turn 2 directly');
  assert.match(calls.replies[0].content, /already have Turn 1/);
  await click(P[1], `cedh:turn:${gameId}:1`); // rescind own turn first
  calls = await click(P[1], `cedh:turn:${gameId}:2`);
  assert.match(calls.followUps[0].content, new RegExp(`took Turn 2 from <@${P[2]}>`));
  assert.match(calls.followUps[0].content, /do \*\*not\*\* confirm/i);

  // --- 5. Confirm the rest; auto-assign fills P2's now-missing turn with 1
  await click(P[1], `cedh:confirm:${gameId}`);
  await click(P[2], `cedh:confirm:${gameId}`);
  calls = await click(P[3], `cedh:confirm:${gameId}`);
  assert.equal(getPendingGame(gameId!), undefined, 'completed game must leave the registry');

  const gm = await db.get('SELECT status FROM games_master WHERE gameId = ?', gameId);
  assert.equal(gm?.status, 'confirmed');
  const rows = await db.all('SELECT userId, turnOrder FROM matches WHERE gameId = ?', gameId);
  const turnOf = Object.fromEntries(rows.map((r: any) => [r.userId, r.turnOrder]));
  assert.deepEqual(turnOf, { [P[0]]: 3, [P[1]]: 2, [P[2]]: 1, [P[3]]: 4 }, 'final turns: live assignments + auto-assigned gap');

  const finalEdit = msgEdits.at(-1)!;
  assert.match(finalEdit.content ?? '', /Game confirmed by all players/);

  await closeDatabase();
  console.log('✅ turn-button UX test passed');
  // complete() leaves a ~1-hour component-strip setTimeout on the event loop;
  // exit explicitly so the test run does not hang on it.
  process.exit(0);
}

main().catch(error => {
  console.error('❌ turn-button UX test FAILED:', error);
  process.exit(1);
});
