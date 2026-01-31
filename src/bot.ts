import { initDatabase } from './db/init.js';
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
import { getAllPlayers, updatePlayerRatingForDecay } from './db/player-utils.js';
import { calculateElo, muFromElo } from './utils/elo-utils.js';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { logRatingChange } from './utils/rating-audit-utils.js';
import { saveOperationSnapshot, DecaySnapshot, DecayPlayerState } from './utils/snapshot-utils.js';

export interface ExtendedClient extends Client {
  commands: Collection<string, {
    data: SlashCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction, client: ExtendedClient) => Promise<void>;
  }>;
  limboGames: Map<string, Set<string>>;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
}) as ExtendedClient;

client.commands = new Collection();
client.limboGames = new Map();

// =============================================
// Rating Decay System (Linear -1 Elo/day)
// =============================================
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const GRACE_DAYS = config.decayStartDays || 6; // Default 6 days grace period
const GRACE_PERIOD_MS = RUN_INTERVAL_MS * GRACE_DAYS;
const ELO_CUTOFF = 1050; // Stop decay at this Elo
const DECAY_ELO_PER_DAY = 1; // Linear decay: exactly -1 Elo per day
const SIGMA_INCREMENT_PER_DECAY = 0.01; // Small sigma increase per decay (uncertainty grows)

/**
 * Linear Rating Decay System
 *
 * After GRACE_DAYS days of not playing:
 * - Players with Elo > ELO_CUTOFF lose exactly DECAY_ELO_PER_DAY Elo per day
 * - Decay continues until Elo reaches ELO_CUTOFF, then stops
 * - Playing a game resets the decay counter
 * - Decay happens to anyone who has played at least 1 game
 *
 * Example: John has 1066 Elo on day 1. After 6 days of not playing:
 * Day 7: 1065, Day 8: 1064, Day 9: 1063... until 1050 (then stops)
 *
 * @param triggeredBy - 'cron' for scheduled decay, 'timewalk' for manual trigger
 * @param adminUserId - Admin user ID if triggered by timewalk
 */
export async function applyRatingDecay(
  triggeredBy: 'cron' | 'timewalk' = 'cron',
  adminUserId?: string
): Promise<number> {
  console.log('[DECAY] Starting linear rating decay process...');
  const now = Date.now();
  const players = await getAllPlayers();
  const decayedPlayers: DecayPlayerState[] = [];

  for (const p of players) {
    // Skip players who haven't played any games (never participated in ranked)
    if (p.gamesPlayed === 0) continue;

    // Skip players who have no lastPlayed timestamp
    if (!p.lastPlayed) continue;

    const msSinceLast = now - new Date(p.lastPlayed).getTime();
    const daysSinceLast = Math.floor(msSinceLast / RUN_INTERVAL_MS);

    // Skip players who played within the grace period
    if (daysSinceLast <= GRACE_DAYS) continue;

    // Calculate current Elo
    const currentElo = calculateElo(p.mu, p.sigma);

    // Skip players who are already at or below the cutoff
    if (currentElo <= ELO_CUTOFF) continue;

    // Calculate how much to decay (linear: -1 Elo per day)
    // Only decay 1 point per decay run (cron runs daily)
    const targetElo = Math.max(currentElo - DECAY_ELO_PER_DAY, ELO_CUTOFF);

    // Calculate new mu to achieve the target Elo (sigma stays mostly stable with small increase)
    const newSigma = Math.min(p.sigma + SIGMA_INCREMENT_PER_DECAY, 10); // Cap sigma at 10
    const newMu = muFromElo(targetElo, newSigma);

    const newElo = calculateElo(newMu, newSigma);

    console.log(
      `[DECAY] ${p.userId}: Elo ${currentElo}→${newElo} ` +
      `(μ: ${p.mu.toFixed(3)}→${newMu.toFixed(3)}, σ: ${p.sigma.toFixed(3)}→${newSigma.toFixed(3)}) ` +
      `[${daysSinceLast} days inactive, grace: ${GRACE_DAYS} days]`
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
      console.error('Error logging decay change to audit trail:', auditError);
    }
  }

  // Save decay snapshot for undo/redo if any players were affected
  if (decayedPlayers.length > 0) {
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
        adminUserId: adminUserId
      },
      timestamp: timestamp,
      description: `Decay cycle affecting ${decayedPlayers.length} player(s)`
    };

    saveOperationSnapshot(decaySnapshot);
    console.log(`[DECAY] Saved decay snapshot for ${decayedPlayers.length} players (undoable)`);
  }

  console.log(`[DECAY] Applied linear decay (-${DECAY_ELO_PER_DAY} Elo) to ${decayedPlayers.length} players`);
  return decayedPlayers.length;
}

async function main() {
  // Initialize database first
  await initDatabase();
  
  // Load commands
  const commandsPath = path.resolve('./dist/commands');
  
  if (!fs.existsSync(commandsPath)) {
    console.error('Commands directory not found. Make sure to run "npm run build" first.');
    process.exit(1);
  }

  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    try {
      const filePath = path.join(commandsPath, file);
      const command = await import(`file://${filePath}`);
      
      if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        console.log(`✓ Loaded command: ${command.data.name}`);
      } else {
        console.warn(`⚠ Command at ${file} missing data or execute export`);
      }
    } catch (error) {
      console.error(`✗ Failed to load command ${file}:`, error);
    }
  }

  client.once(Events.ClientReady, async () => {
    console.log(`🤖 Bot logged in as ${client.user?.tag}`);
    console.log(`📊 Database initialized`);
    console.log(`⚙️ Loaded ${client.commands.size} commands`);
    console.log(`📄 Linear rating decay system active (${GRACE_DAYS} day grace period, -${DECAY_ELO_PER_DAY} Elo/day after grace period)`);
    
    // Run initial decay check
    await applyRatingDecay();
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.error(`No command matching ${interaction.commandName} found`);
      return;
    }

    try {
      await command.execute(interaction, client);
    } catch (error) {
      console.error(`Error executing command ${interaction.commandName}:`, error);
      const errorResponse = 'There was an error executing this command.';
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorResponse, ephemeral: true });
      } else {
        await interaction.reply({ content: errorResponse, ephemeral: true });
      }
    }
  });

  // Handle DM commands for admin opt in/out
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot || message.guild) return;

    const isAdmin = config.admins.includes(message.author.id);
    const content = message.content.toLowerCase().trim();

    if (!isAdmin) {
      await message.reply("Only registered admins can use this command.");
      return;
    }

    if (content === '!optout') {
      await setAlertOptIn(message.author.id, false);
      await message.reply("✅ You will no longer receive suspicious activity alerts.");
    } else if (content === '!optin') {
      await setAlertOptIn(message.author.id, true);
      await message.reply("✅ You will now receive suspicious activity alerts.");
    }
  });

  // Schedule daily rating decay at midnight
  cron.schedule('0 0 * * *', () => {
    console.log('[DECAY] Scheduled daily decay starting...');
    applyRatingDecay().catch(error => {
      console.error('[DECAY] Error during scheduled decay:', error);
    });
  });

  await client.login(config.token);
}

main().catch(console.error);