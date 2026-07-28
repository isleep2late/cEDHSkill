/**
 * Integration test: turn-order buttons on admin/mod auto-confirmed games.
 *
 * Guards the submission-time button filtering:
 *   1. full inline turn order (explicit, or 3-of-4 + auto-fill) → NO turn
 *      buttons are attached and the embed never advertises them;
 *   2. partial inline turn order → only the still-open turns get buttons,
 *      and the embed says submission-assigned turns are fixed;
 *   3. router: a player whose turn was fixed at submission and who clicks a
 *      remaining button is told their turn can't be changed (instead of being
 *      pointed at a rescind button that doesn't exist), while players without
 *      a turn can still claim/rescind the open turns against the database;
 *   4. injected (backdated) games whose 1-hour window is already closed get
 *      neither turn buttons nor an embed hint advertising them.
 *
 * Run with: npm test  (uses tsx; no Discord connection required)
 */

// Required by src/config.ts — must be set before any project module is imported.
process.env.DISCORD_TOKEN ??= 'test-token';
process.env.CLIENT_ID ??= 'test-client-id';
process.env.GUILD_ID ??= 'test-guild-id';
const ADMIN = '999999999999999999';
process.env.ADMINS = ADMIN; // the submitter — none of the players

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

type Sent = { content?: string; embeds?: any[]; components?: any[] };

// Unwrap an EmbedBuilder (or raw embed) from a message payload.
function embedData(payload: Sent): { title?: string; description: string } {
  const e: any = payload.embeds![0];
  return e?.toJSON ? e.toJSON() : e?.data ?? e;
}

// Flatten every turn-button customId out of a message-edit payload.
function turnButtonIds(payload: Sent): string[] {
  const ids: string[] = [];
  for (const row of payload.components ?? []) {
    const data: any = (row as any).toJSON ? (row as any).toJSON() : row;
    for (const component of data.components ?? []) {
      const id = component.custom_id ?? component.customId;
      if (typeof id === 'string' && id.startsWith('cedh:turn:')) ids.push(id);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  // src/db/init.ts resolves data/cEDHSkill.db relative to the CWD at import time,
  // so switch to a temp dir before importing any project module.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cedhskill-admin-turn-'));
  process.chdir(tempDir);

  const { initDatabase, getDatabase, closeDatabase } = await import('../src/db/init.js');
  await initDatabase();
  const db = getDatabase();

  const { execute } = await import('../src/commands/rank.js');
  const { handleGameButton } = await import('../src/utils/button-handlers.js');

  const client: any = {
    user: { id: 'bot-user' },
    users: { fetch: async (id: string) => ({ id, username: `user-${id.slice(0, 3)}`, send: async () => {} }) },
    limboGames: new Map(),
  };

  const P = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444'];

  // Submit a game as the admin and capture everything sent to the message.
  async function submit(results: string, aftergame?: string) {
    const editReplies: Sent[] = [];
    const msgEdits: Sent[] = [];
    const replyMsg: any = {
      id: `admin-msg-${Math.random().toString(36).slice(2)}`,
      channel: { send: async () => ({}) },
      edit: async (p: any) => { msgEdits.push(p); return replyMsg; },
    };
    const interaction: any = {
      user: { id: ADMIN },
      client,
      options: {
        getString: (name: string) =>
          name === 'results' ? results : name === 'aftergame' ? aftergame ?? null : null,
      },
      deferReply: async () => {},
      editReply: async (p: any) => { editReplies.push(p); return replyMsg; },
      followUp: async () => ({ delete: async () => {} }),
    };
    await execute(interaction, client);
    const embed = embedData(editReplies.at(-1)!);
    assert.match(embed.title ?? '', /Auto Confirmed/, 'admin submission must auto-confirm');
    const gameId = embed.description.match(/Game ID: ([0-9A-F]{6})/)?.[1];
    assert.ok(gameId, 'auto-confirm embed should contain the game ID');
    return { gameId: gameId!, description: embed.description, msgEdits, replyMsg };
  }

  async function turnsInDb(gameId: string): Promise<Record<string, number | null>> {
    const rows = await db.all('SELECT userId, turnOrder FROM matches WHERE gameId = ?', gameId);
    return Object.fromEntries(rows.map((r: any) => [r.userId, r.turnOrder]));
  }

  // --- 1a. Full inline turn order → no turn buttons, no button hint --------
  const full = await submit(`<@${P[0]}> w 3 <@${P[1]}> l 1 <@${P[2]}> l 2 <@${P[3]}> l 4`);
  assert.match(full.description, /Turn Order Assigned:/);
  assert.doesNotMatch(full.description, /buttons?\W+below/i, 'fully assigned game must not advertise turn buttons');
  for (const edit of full.msgEdits) {
    assert.deepEqual(turnButtonIds(edit), [], 'fully assigned game must never get turn buttons attached');
  }
  assert.deepEqual(await turnsInDb(full.gameId), { [P[0]]: 3, [P[1]]: 1, [P[2]]: 2, [P[3]]: 4 });

  // --- 1b. 3-of-4 inline (auto-fill completes it) → still no turn buttons --
  const filled = await submit(`<@${P[0]}> w 2 <@${P[1]}> l 1 <@${P[2]}> l 3 <@${P[3]}> l`);
  assert.doesNotMatch(filled.description, /buttons?\W+below/i);
  for (const edit of filled.msgEdits) {
    assert.deepEqual(turnButtonIds(edit), [], 'auto-filled game must never get turn buttons attached');
  }
  assert.deepEqual(await turnsInDb(filled.gameId), { [P[0]]: 2, [P[1]]: 1, [P[2]]: 3, [P[3]]: 4 });

  // --- 2. Partial inline turn order → buttons only for the open turns ------
  const partial = await submit(`<@${P[0]}> w 1 <@${P[1]}> l 3 <@${P[2]}> l <@${P[3]}> l`);
  assert.match(partial.description, /turns assigned at submission are fixed/i);
  const buttonEdits = partial.msgEdits.filter(e => turnButtonIds(e).length > 0);
  assert.equal(buttonEdits.length, 1, 'partial game should attach turn buttons exactly once');
  assert.deepEqual(
    turnButtonIds(buttonEdits[0]),
    [`cedh:turn:${partial.gameId}:2`, `cedh:turn:${partial.gameId}:4`],
    'only the unassigned turns may get buttons'
  );

  // --- 3. Router behavior on the partial game (DB-backed, no pending state)
  // The click interaction's message mirrors what Discord would hold: the
  // filtered button row that was actually attached.
  const liveComponents = [{
    components: turnButtonIds(buttonEdits[0]).map(id => ({ customId: id })),
  }];
  function click(userId: string, customId: string) {
    const calls = { followUps: [] as any[], replies: [] as any[] };
    const interaction: any = {
      user: { id: userId },
      customId,
      client,
      message: { embeds: [], components: liveComponents },
      deferUpdate: async () => {},
      followUp: async (p: any) => { calls.followUps.push(p); },
      reply: async (p: any) => { calls.replies.push(p); },
      editReply: async () => ({}),
    };
    return handleGameButton(interaction).then(() => calls);
  }

  // A submission-assigned player clicking an open turn: turn is fixed, and the
  // reply must NOT point at a rescind button that doesn't exist.
  let calls = await click(P[0], `cedh:turn:${partial.gameId}:2`);
  assert.equal(calls.followUps.length, 1, 'fixed-turn player must get an ephemeral notice');
  assert.match(calls.followUps[0].content, /assigned when the game was submitted/i);
  assert.doesNotMatch(calls.followUps[0].content, /click "Turn/i);
  assert.equal((await turnsInDb(partial.gameId))[P[0]], 1, 'fixed turn must be unchanged');

  // A player without a turn claims an open one (persisted to the database) ...
  await click(P[2], `cedh:turn:${partial.gameId}:2`);
  assert.equal((await turnsInDb(partial.gameId))[P[2]], 2, 'open turn must be claimable');

  // ... can still be told to rescind first (that button DOES exist) ...
  calls = await click(P[2], `cedh:turn:${partial.gameId}:4`);
  assert.match(calls.followUps[0].content, /Click "Turn 2" again to rescind/);

  // ... and can rescind their button-claimed turn.
  calls = await click(P[2], `cedh:turn:${partial.gameId}:2`);
  assert.match(calls.followUps[0].content, /rescinded/i);
  assert.equal((await turnsInDb(partial.gameId))[P[2]], null, 'button-claimed turn must be rescindable');

  // --- 4. Injected (backdated) game → no buttons, no hint ------------------
  // Backdate the existing games so the pre-injection timestamp (first game
  // minus 1 hour) lands far outside the 1-hour turn window.
  await db.run("UPDATE games_master SET createdAt = datetime('now', '-3 hours')");
  const injected = await submit(`<@${P[0]}> w 1 <@${P[1]}> l 3 <@${P[2]}> l <@${P[3]}> l`, '0');
  assert.match(injected.description, /Pre-Injection/i, 'aftergame:0 must take the injection path');
  assert.doesNotMatch(injected.description, /turns assigned at submission are fixed/i,
    'closed-window injected game must not show the partial-assignment hint');
  assert.doesNotMatch(injected.description, /buttons?\W+below/i,
    'closed-window injected game must not advertise turn buttons');
  for (const edit of injected.msgEdits) {
    assert.deepEqual(turnButtonIds(edit), [], 'closed-window injected game must never get turn buttons attached');
  }

  await closeDatabase();
  console.log('✅ admin turn-button filtering test passed');
  // The partial game leaves a ~1-hour component-strip setTimeout on the event
  // loop; exit explicitly so the test run does not hang on it.
  process.exit(0);
}

main().catch(error => {
  console.error('❌ admin turn-button filtering test FAILED:', error);
  process.exit(1);
});
