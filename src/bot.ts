// initDatabase is called by loader.ts before this module is imported
import {
  Client,
  GatewayIntentBits,
  Interaction,
  Collection,
  Events,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  Partials,
} from 'discord.js';
import { config } from './config.js';
import { setAlertOptIn } from './utils/suspicion-utils.js';
import { getAllPlayers, updatePlayerRatingForDecay, getOrCreatePlayer } from './db/player-utils.js';
import { calculateElo, sigmaFromElo } from './utils/elo-utils.js';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { logRatingChange } from './utils/rating-audit-utils.js';
import { saveOperationSnapshot, DecaySnapshot, DecayPlayerState } from './utils/snapshot-utils.js';
import { logger } from './utils/logger.js';

export interface ExtendedClient extends Client {
  commands: Collection<string, {
    data: SlashCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction, client: ExtendedClient) => Promise<void>;
  }>;
  limboGames: Map<string, { gameId: string; gameType: 'player' | 'deck'; players: Set<string> }>;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    // REQUIRED for game confirmations. Game results are confirmed via
    // replyMsg.createReactionCollector(...) in commands/rank.ts; reaction
    // collectors only receive events when this intent is enabled. It was
    // removed in 6307cf3 to cut event-flooding, which silently broke all
    // player 👍 confirmations (admin auto-submit still worked because that's
    // an interaction, not a reaction). Do NOT remove this again.
    //
    // GuildMessages/MessageContent stay OUT on purpose: they were the real
    // flood source in the 15k-member server and the bot doesn't use them
    // (messageCreate only handles DMs, which don't require those intents).
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Message/Reaction partials let the collector still receive reactions if the
  // confirmation message is evicted from cache during its 1-hour window.
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
}) as ExtendedClient;

client.commands = new Collection();
client.limboGames = new Map();

// =============================================
// Rating Decay System (Sigma-based, -1 Elo/day)
//
// Decay increases sigma (uncertainty) rather than decreasing mu (skill).
// This means inactivity reduces confidence in a player's rating, not
// their estimated skill level. When they play again, the higher sigma
// causes OpenSkill to weight new results more heavily, allowing their
// rating to quickly reconverge.
//
// With Elo = 1000 + 25 * (mu - 3 * sigma), each +1/75 sigma ≈ -1 Elo.
// Pre-decay Elo uses the player's preDecaySigma (sigma from last game), not base 8.333.
// =============================================
/**
 * Parse a datetime string as UTC, even if it lacks timezone info.
 * SQLite's CURRENT_TIMESTAMP produces bare datetimes like '2026-02-09 05:53:34'
 * (no T, no Z). JavaScript's new Date() treats these as local time on non-UTC
 * servers. This normalizes to ISO 8601 UTC format before parsing.
 */
function parseDateAsUTC(dateStr: string): Date {
  if (dateStr.includes('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }
  return new Date(dateStr.replace(' ', 'T') + 'Z');
}

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Calculate the number of local calendar days between two dates.
 * Truncates both dates to their local-timezone date component (midnight)
 * before computing the difference. This aligns day boundaries with the
 * cron schedule, which fires at local midnight (e.g. 00:00 EST).
 *
 * Using local time (not UTC) matters because timestamps are stored in UTC,
 * but a game played at 11 PM EST on Feb 9 is recorded as 04:00 UTC Feb 10.
 * UTC calendar days would count that as Feb 10, but the player and the cron
 * both consider it Feb 9. Local calendar days give the correct count.
 *
 * Math.round handles DST transitions (23h or 25h days) correctly.
 */
function localCalendarDaysBetween(earlier: Date, later: Date): number {
  const earlierMidnight = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate()).getTime();
  const laterMidnight = new Date(later.getFullYear(), later.getMonth(), later.getDate()).getTime();
  return Math.round((laterMidnight - earlierMidnight) / RUN_INTERVAL_MS);
}
const GRACE_DAYS = config.decayStartDays || 6; // Default 6 days grace period
const GRACE_PERIOD_MS = RUN_INTERVAL_MS * GRACE_DAYS;
const ELO_CUTOFF = 1050; // Stop decay at this Elo
const DECAY_ELO_PER_DAY = 1; // Linear decay: exactly -1 Elo per day via sigma increase

// Timewalk: Simple virtual clock
// - cumulativeTimewalkDays = the current position of the virtual clock
// - playerLastPlayPosition = where each player was on the virtual clock when they last played
// - Player's virtual inactivity = cumulativeTimewalkDays - playerLastPlayPosition[userId]
let cumulativeTimewalkDays = 0;
const playerLastPlayPosition = new Map<string, number>(); // userId -> cumulative days when they last played

/**
 * Record that a player just played a game.
 * Their "virtual last played" position is set to the current cumulative.
 */
export function recordPlayerActivity(userId: string): void {
  playerLastPlayPosition.set(userId, cumulativeTimewalkDays);
}

/**
 * Get a player's virtual days of inactivity.
 * = current virtual time - their virtual last played time
 */
export function getPlayerVirtualInactivity(userId: string): number {
  const lastPosition = playerLastPlayPosition.get(userId) ?? 0;
  return cumulativeTimewalkDays - lastPosition;
}

/**
 * Add days to the virtual clock.
 */
export function addTimewalkDays(days: number): void {
  cumulativeTimewalkDays += days;
  logger.info(`[TIMEWALK] Virtual clock: Day ${cumulativeTimewalkDays}`);
}

/**
 * Reset the virtual clock and all player positions.
 */
export function resetTimewalkDays(): void {
  if (cumulativeTimewalkDays > 0) {
    logger.info(`[TIMEWALK] Resetting virtual clock (was day ${cumulativeTimewalkDays})`);
  }
  cumulativeTimewalkDays = 0;
  playerLastPlayPosition.clear();
}

/**
 * Get the current virtual clock position.
 */
export function getTimewalkDays(): number {
  return cumulativeTimewalkDays;
}

/**
 * Subtract days from the virtual clock (used when undoing a timewalk).
 */
export function subtractTimewalkDays(days: number): void {
  cumulativeTimewalkDays = Math.max(0, cumulativeTimewalkDays - days);
  logger.info(`[TIMEWALK] Virtual clock reversed to: Day ${cumulativeTimewalkDays}`);
}

/**
 * Save a timewalk event to the database for persistence across recalculations.
 */
export async function saveTimewalkEvent(days: number, adminUserId: string): Promise<number> {
  const { getDatabase } = await import('./db/init.js');
  const db = getDatabase();
  const result = await db.run(
    'INSERT INTO timewalk_events (days, adminUserId) VALUES (?, ?)',
    [days, adminUserId]
  );
  logger.info(`[TIMEWALK] Saved timewalk event (id=${result.lastID}, +${days} days) to database`);
  return result.lastID!;
}

/**
 * Get all active timewalk events, ordered chronologically.
 */
export async function getActiveTimewalkEvents(): Promise<Array<{ id: number; days: number; createdAt: string }>> {
  const { getDatabase } = await import('./db/init.js');
  const db = getDatabase();
  return db.all('SELECT id, days, createdAt FROM timewalk_events WHERE active = 1 ORDER BY createdAt ASC');
}

/**
 * Deactivate a timewalk event (used when undoing a timewalk decay).
 */
export async function deactivateTimewalkEvent(eventId: number): Promise<void> {
  const { getDatabase } = await import('./db/init.js');
  const db = getDatabase();
  await db.run('UPDATE timewalk_events SET active = 0 WHERE id = ?', [eventId]);
  logger.info(`[TIMEWALK] Deactivated timewalk event id=${eventId}`);
}

/**
 * Reactivate a timewalk event (used when redoing a timewalk decay).
 */
export async function reactivateTimewalkEvent(eventId: number): Promise<void> {
  const { getDatabase } = await import('./db/init.js');
  const db = getDatabase();
  await db.run('UPDATE timewalk_events SET active = 1 WHERE id = ?', [eventId]);
  logger.info(`[TIMEWALK] Reactivated timewalk event id=${eventId}`);
}

/**
 * Calculate the minimum days to fast-forward until a decay occurs.
 * Uses virtual clock: player's inactivity = virtual_clock - their_last_play_position
 */
export async function getMinDaysForNextDecay(): Promise<number> {
  const players = await getAllPlayers();

  let minDaysNeeded = Infinity;

  for (const p of players) {
    // Skip players who haven't played any games
    if (p.gamesPlayed === 0) continue;

    // Skip players who have no lastPlayed timestamp
    if (!p.lastPlayed) continue;

    // Calculate current Elo - skip if already at or below cutoff
    const currentElo = calculateElo(p.mu, p.sigma);
    if (currentElo <= ELO_CUTOFF) continue;

    // Player's virtual inactivity = current virtual clock - their last play position
    const virtualInactivity = getPlayerVirtualInactivity(p.userId);

    if (virtualInactivity > GRACE_DAYS) {
      // Player is already past grace - just need 1 day to trigger next decay
      return 1;
    } else {
      // Calculate days needed to pass grace period for this player
      const daysNeeded = GRACE_DAYS + 1 - virtualInactivity;
      minDaysNeeded = Math.min(minDaysNeeded, daysNeeded);
    }
  }

  // If no eligible players found, default to grace + 1
  return minDaysNeeded === Infinity ? GRACE_DAYS + 1 : minDaysNeeded;
}

/**
 * Sigma-Based Rating Decay System
 *
 * After GRACE_DAYS days of not playing:
 * - Players with Elo > ELO_CUTOFF lose exactly DECAY_ELO_PER_DAY Elo per day
 * - Decay is applied by increasing sigma (uncertainty), NOT by decreasing mu (skill)
 * - Each +1/75 sigma = -1 Elo (since Elo = 1000 + 25 * (mu - 3 * sigma))
 * - Mu (estimated skill) is preserved — only confidence decreases
 * - When the player returns, their higher sigma causes OpenSkill to weight
 *   new game results more heavily, allowing ratings to reconverge quickly
 * - Decay continues until Elo reaches ELO_CUTOFF, then stops
 * - Playing a game resets the decay counter
 *
 * Example: John has 1066 Elo (mu=27.5, sigma=4.0) on day 1. After 6 days of not playing:
 * Day 7: 1065 (sigma=4.25), Day 8: 1064 (sigma=4.50), Day 9: 1063 (sigma=4.75)...
 * until Elo reaches 1050, then stops.
 *
 * @param triggeredBy - 'cron' for scheduled decay, 'timewalk' for manual trigger
 * @param adminUserId - Admin user ID if triggered by timewalk
 * @param simulatedDaysOffset - For timewalk: pretend this many extra days have passed
 * @param skipSnapshot - If true, skip creating undo snapshot (used during recalculation)
 */
export async function applyRatingDecay(
  triggeredBy: 'cron' | 'timewalk' = 'cron',
  adminUserId?: string,
  simulatedDaysOffset: number = 0,
  skipSnapshot: boolean = false,
  timewalkEventId?: number
): Promise<number> {
  logger.info('[DECAY] Starting sigma-based rating decay process...');

  const isTimewalk = triggeredBy === 'timewalk';
  const now = Date.now();
  const players = await getAllPlayers();
  const decayedPlayers: DecayPlayerState[] = [];

  for (const p of players) {
    // Skip players who haven't played any games (never participated in ranked)
    if (p.gamesPlayed === 0) continue;

    // Skip players who have no lastPlayed timestamp
    if (!p.lastPlayed) continue;

    let daysSinceLast: number;
    let daysPastGrace: number;

    if (isTimewalk) {
      // Virtual clock model:
      // - Current virtual inactivity = current_clock - player_last_position
      // - After this timewalk: new_clock = current_clock + simulatedDaysOffset
      // - New inactivity = new_clock - player_last_position
      // - NEW days past grace = new_days_past_grace - current_days_past_grace
      const currentInactivity = getPlayerVirtualInactivity(p.userId);
      const newInactivity = currentInactivity + simulatedDaysOffset;

      const currentDaysPastGrace = Math.max(0, currentInactivity - GRACE_DAYS);
      const newDaysPastGrace = Math.max(0, newInactivity - GRACE_DAYS);
      daysPastGrace = newDaysPastGrace - currentDaysPastGrace; // Only decay for NEW days

      daysSinceLast = newInactivity; // For logging
    } else {
      // Cron job: use UTC calendar days since lastPlayed.
      // Calendar days (not exact 24h periods) prevent off-by-one errors when
      // the cron execution time is earlier in the day than the lastPlayed time.
      const lastPlayedDate = parseDateAsUTC(p.lastPlayed);
      daysSinceLast = localCalendarDaysBetween(lastPlayedDate, new Date(now));
      daysPastGrace = Math.max(0, daysSinceLast - GRACE_DAYS);
    }

    // Skip if no decay needed (either within grace period OR no new days to decay for timewalk)
    if (daysPastGrace <= 0) continue;

    // Calculate the pre-decay Elo using the player's sigma from their last game
    // (not base sigma 8.333 — players with low sigma from many games have an Elo
    // bonus that must be preserved as the decay starting point)
    const gameBaseSigma = p.preDecaySigma ?? 8.333;
    const originalElo = calculateElo(p.mu, gameBaseSigma);

    // Skip players whose original Elo is at or below the cutoff
    if (originalElo <= ELO_CUTOFF) continue;

    // Calculate total decay from ORIGINAL Elo: -1 Elo per day past grace period
    // This ensures linear decay (not compounding) across multiple cron runs
    const totalDecay = daysPastGrace * DECAY_ELO_PER_DAY;
    const targetElo = Math.max(originalElo - totalDecay, ELO_CUTOFF);

    // Skip if player is already at or below the target (from a prior decay run)
    const currentElo = calculateElo(p.mu, p.sigma);
    if (targetElo >= currentElo) continue;

    // Decay by increasing sigma (uncertainty) only — mu (skill) stays unchanged.
    // Solve for the sigma that produces targetElo with the player's current mu.
    const newSigma = sigmaFromElo(targetElo, p.mu);
    const newMu = p.mu; // Skill estimate is preserved

    const newElo = calculateElo(newMu, newSigma);
    const actualDecay = currentElo - newElo;

    logger.info(
      `[DECAY] ${p.userId}: Elo ${currentElo}→${newElo} (-${actualDecay}) ` +
      `(mu: ${p.mu.toFixed(3)}→${newMu.toFixed(3)}, sigma: ${p.sigma.toFixed(3)}→${newSigma.toFixed(3)}) ` +
      `[${daysSinceLast} days inactive, ${daysPastGrace} days past grace]`
    );

    // Track player state for undo snapshot
    decayedPlayers.push({
      userId: p.userId,
      beforeMu: p.mu,
      beforeSigma: p.sigma,
      afterMu: newMu,
      afterSigma: newSigma,
      wins: p.wins,
      losses: p.losses,
      draws: p.draws
    });

    await updatePlayerRatingForDecay(p.userId, newMu, newSigma, p.wins, p.losses, p.draws);

    // Log the decay change for audit trail
    try {
      await logRatingChange({
        targetType: 'player',
        targetId: p.userId,
        targetDisplayName: `Player ${p.userId}`,
        changeType: 'decay',
        oldMu: p.mu,
        oldSigma: p.sigma,
        oldElo: currentElo,
        newMu: newMu,
        newSigma: newSigma,
        newElo: newElo,
        parameters: JSON.stringify({
          daysSinceLastPlayed: daysSinceLast,
          graceDays: GRACE_DAYS,
          decayAmount: currentElo - newElo,
          eloCutoff: ELO_CUTOFF,
          triggeredBy: triggeredBy
        })
      });
    } catch (auditError) {
      logger.error('Error logging decay change to audit trail:', auditError);
    }
  }

  // Save decay snapshot for undo/redo if any players were affected
  // Skip snapshot during recalculation (parent operation handles undo)
  if (decayedPlayers.length > 0 && !skipSnapshot) {
    const timestamp = new Date().toISOString();
    const decaySnapshot: DecaySnapshot = {
      matchId: `decay-${Date.now()}`,
      gameId: 'decay',
      gameSequence: Date.now(),
      gameType: 'decay',
      players: decayedPlayers,
      metadata: {
        graceDays: GRACE_DAYS,
        eloCutoff: ELO_CUTOFF,
        decayAmount: DECAY_ELO_PER_DAY,
        triggeredBy: triggeredBy,
        adminUserId: adminUserId,
        simulatedDaysOffset: simulatedDaysOffset,
        timewalkEventId: timewalkEventId
      },
      timestamp: timestamp,
      description: simulatedDaysOffset > 0
        ? `Timewalk decay (+${simulatedDaysOffset} day${simulatedDaysOffset > 1 ? 's' : ''}) affecting ${decayedPlayers.length} player(s)`
        : `Decay cycle affecting ${decayedPlayers.length} player(s)`
    };

    saveOperationSnapshot(decaySnapshot);
    logger.info(`[DECAY] Saved decay snapshot for ${decayedPlayers.length} players (undoable)`);
  }

  logger.info(`[DECAY] Applied sigma-based decay to ${decayedPlayers.length} players`);
  return decayedPlayers.length;
}

/**
 * Apply inter-game decay for specific players up to a reference date.
 * Used during recalculation to interleave decay between game replays.
 *
 * Only applies decay to the specified player IDs, using their current
 * lastPlayed date and the game's date to calculate the inactivity gap.
 * Decay increases sigma (uncertainty) only — mu (skill) is preserved.
 * No snapshot or audit logging (this is part of a larger recalculation).
 */
export async function applyDecayForPlayers(
  playerIds: string[],
  referenceDate: Date
): Promise<number> {
  let decayCount = 0;

  for (const userId of playerIds) {
    const player = await getOrCreatePlayer(userId);

    // Skip players who haven't played any games yet (no lastPlayed)
    if (!player.lastPlayed) continue;

    // Calculate UTC calendar days between lastPlayed and the reference date (the upcoming game)
    const lastPlayedDate = parseDateAsUTC(player.lastPlayed);
    if (referenceDate.getTime() <= lastPlayedDate.getTime()) continue; // Game is before or at lastPlayed - no gap

    const daysSinceLast = localCalendarDaysBetween(lastPlayedDate, referenceDate);
    const daysPastGrace = Math.max(0, daysSinceLast - GRACE_DAYS);

    if (daysPastGrace <= 0) continue;

    // Calculate the pre-decay Elo using the player's sigma from their last game
    // (not base sigma 8.333 — players with low sigma from many games have an Elo
    // bonus that must be preserved as the decay starting point)
    const gameBaseSigma = player.preDecaySigma ?? 8.333;
    const originalElo = calculateElo(player.mu, gameBaseSigma);
    if (originalElo <= ELO_CUTOFF) continue;

    // Apply decay from ORIGINAL Elo: -1 Elo per day past grace, floored at cutoff
    // Decay increases sigma only — mu (skill) is preserved
    const totalDecay = daysPastGrace * DECAY_ELO_PER_DAY;
    const targetElo = Math.max(originalElo - totalDecay, ELO_CUTOFF);

    // Skip if player is already at or below the target
    const currentElo = calculateElo(player.mu, player.sigma);
    if (targetElo >= currentElo) continue;

    const newSigma = sigmaFromElo(targetElo, player.mu);
    const newMu = player.mu; // Skill estimate is preserved

    await updatePlayerRatingForDecay(userId, newMu, newSigma, player.wins, player.losses, player.draws);
    decayCount++;
  }

  return decayCount;
}

async function main() {
  // Note: Database is already initialized by loader.ts before this module is imported.
  // Do NOT call initDatabase() here - it would re-open the database connection.

  // Load commands
  const commandsPath = path.resolve('./dist/commands');
  
  if (!fs.existsSync(commandsPath)) {
    logger.error('Commands directory not found. Make sure to run "npm run build" first.');
    process.exit(1);
  }

  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    try {
      const filePath = path.join(commandsPath, file);
      const command = await import(`file://${filePath}`);
      
      if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        logger.info(`Loaded command: ${command.data.name}`);
      } else {
        logger.warn(`Command at ${file} missing data or execute export`);
      }
    } catch (error) {
      logger.error(`Failed to load command ${file}:`, error);
    }
  }

  client.once(Events.ClientReady, async () => {
    logger.info(`Bot logged in as ${client.user?.tag}`);
    logger.info(`Database initialized`);
    logger.info(`Loaded ${client.commands.size} commands: ${Array.from(client.commands.keys()).join(', ')}`);
    logger.info(`Sigma-based rating decay active (${GRACE_DAYS} day grace period, -${DECAY_ELO_PER_DAY} Elo/day via sigma increase)`);

    // Check if grace days config changed since last run — if so, full recalculation needed
    try {
      const { getBotConfig, setBotConfig } = await import('./db/database-utils.js');
      const storedGraceDays = await getBotConfig('graceDays');
      const currentGraceDays = String(GRACE_DAYS);

      if (storedGraceDays !== currentGraceDays) {
        // First run (null) or config changed — full recalculation ensures
        // decay is correctly applied with the current grace period
        if (storedGraceDays === null) {
          logger.info(`[STARTUP] First run with config tracking — triggering full recalculation to establish baseline...`);
        } else {
          logger.info(`[STARTUP] Grace days changed from ${storedGraceDays} to ${currentGraceDays} — triggering full recalculation...`);
        }
        const { recalculateAllPlayersFromScratch } = await import('./commands/rank.js');
        await recalculateAllPlayersFromScratch();
        logger.info(`[STARTUP] Full recalculation complete with grace period of ${currentGraceDays} days`);
      } else {
        // No config change — just run normal decay catch-up
        await applyRatingDecay();
      }

      // Persist the current grace days value for next startup comparison
      await setBotConfig('graceDays', currentGraceDays);
    } catch (error) {
      logger.error('[STARTUP] Error during initial decay/recalculation check:', error);
      logger.error('[STARTUP] Bot will continue running. Decay will retry on next scheduled run.');
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // SHARED-TOKEN SAFETY: this bot account runs as several concurrent processes
    // (cEDH + the two Pokémon servers), one per server. Discord delivers EVERY
    // interaction to ALL of them, so each process must ignore interactions from
    // any guild other than its own — otherwise multiple bots race to acknowledge
    // the same command (10062 / 40060 "already acknowledged") and the wrong bot
    // can answer it against the wrong database. config.guildId is this process's
    // server; bail on anything else (including a null guildId from a DM).
    if (interaction.guildId !== config.guildId) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      logger.error(`No command matching ${interaction.commandName} found`);
      return;
    }

    // Extract all command options for logging
    const options: Record<string, any> = {};
    for (const opt of interaction.options.data) {
      if (opt.type === 6) { // USER type
        options[opt.name] = `@${(opt.user as any)?.username || opt.value} (${opt.value})`;
      } else {
        options[opt.name] = opt.value;
      }
    }

    const userName = interaction.user.username;
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    logger.command(interaction.commandName, userId, userName, guildId, options);
    const startTime = Date.now();

    try {
      await command.execute(interaction, client);
      const duration = Date.now() - startTime;
      logger.commandComplete(interaction.commandName, userId, duration, 'success');
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.commandError(interaction.commandName, userId, error);
      logger.commandComplete(interaction.commandName, userId, duration, 'error');
      const errorResponse = 'There was an error executing this command.';

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: errorResponse, ephemeral: true });
        } else {
          await interaction.reply({ content: errorResponse, ephemeral: true });
        }
      } catch (replyError) {
        logger.error(`Could not send error response for ${interaction.commandName}:`, replyError);
      }
    }
  });

  // Handle DM commands for admin/moderator opt in/out
  client.on('messageCreate', async (message: Message) => {
    try {
      if (message.author.bot || message.guild) return;

      const isAdmin = config.admins.includes(message.author.id);
      const isMod = config.moderators.includes(message.author.id);
      const hasAccess = isAdmin || isMod;
      const content = message.content.toLowerCase().trim();

      logger.info(`[DM] From ${message.author.username} (${message.author.id}): "${content}" | admin: ${isAdmin} | mod: ${isMod}`);

      // SHARED-TOKEN SAFETY: DMs carry no guild, so every bot process on this
      // account receives them. Silently ignore DMs from anyone who isn't an
      // admin/mod of THIS bot's server, so a stranger isn't answered once per
      // running bot. (Someone who administers more than one of these servers
      // gets one reply per server — each server's alert setting is separate, so
      // the reply is labelled with the server name below.)
      if (!hasAccess) return;

      const serverLabel = client.guilds.cache.get(config.guildId)?.name ?? 'this server';

      if (content === '!optout') {
        await setAlertOptIn(message.author.id, false);
        await message.reply(`✅ [${serverLabel}] You will no longer receive suspicious activity alerts.`);
        logger.info(`[DM] ${message.author.username} opted out of alerts`);
      } else if (content === '!optin') {
        await setAlertOptIn(message.author.id, true);
        await message.reply(`✅ [${serverLabel}] You will now receive suspicious activity alerts.`);
        logger.info(`[DM] ${message.author.username} opted in to alerts`);
      }
    } catch (error) {
      logger.error(`[DM] Error handling DM from ${message.author?.id}:`, error);
    }
  });

  // Periodically clean up abandoned limbo games (every 30 minutes)
  setInterval(() => {
    const now = Date.now();
    const TTL_MS = 60 * 60 * 1000; // 1 hour
    for (const [key, value] of client.limboGames.entries()) {
      // limboGames entries don't have timestamps, so just cap the total size
      if (client.limboGames.size > 50) {
        client.limboGames.delete(key);
        logger.info(`[LIMBO] Cleaned up stale limbo game entry: ${key}`);
      }
    }
  }, 30 * 60 * 1000);

  // Schedule daily rating decay at midnight
  cron.schedule('0 0 * * *', () => {
    logger.info('[DECAY] Scheduled daily decay starting...');
    applyRatingDecay().catch(error => {
      logger.error('[DECAY] Error during scheduled decay:', error);
    });
  });

  await client.login(config.token);
}

// Export main so loader.ts can call it after initializing the database.
// Do NOT call main() here — command files import from this module,
// and auto-executing would start the bot without DB initialization.
export { main };