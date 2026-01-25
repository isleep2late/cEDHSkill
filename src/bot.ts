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
import { calculateElo } from './utils/elo-utils.js';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { logRatingChange } from './utils/rating-audit-utils.js';

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
// Rating Decay System (Integrated)
// =============================================
const DECAY_RATE_PER_RUN = 0.005;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const GRACE_RUNS = config.decayStartDays || 8;
const GRACE_PERIOD_MS = RUN_INTERVAL_MS * GRACE_RUNS;
const ELO_CUTOFF = 1050;
const MAX_SIGMA = 10;

function muFromElo(targetElo: number, sigma: number): number {
  const sigmaPenalty = (sigma - 8.333) * 4;
  return ((targetElo - 1000 + sigmaPenalty) / 12) + 25;
}

async function applyRatingDecay(): Promise<void> {
  console.log('[DECAY] Starting rating decay process...');
  const now = Date.now();
  const players = await getAllPlayers();
  let decayedCount = 0;

  for (const p of players) {
    // Skip players who haven't played any games
    if (p.gamesPlayed === 0) continue;

    // Skip players who played recently
    if (!p.lastPlayed) continue;
    const msSinceLast = now - new Date(p.lastPlayed).getTime();
    if (msSinceLast < GRACE_PERIOD_MS) continue;

    // Skip players under Elo cutoff
    const currentElo = calculateElo(p.mu, p.sigma);
    if (currentElo < ELO_CUTOFF) continue;

    // Apply decay
    const sigmaInc = (MAX_SIGMA - p.sigma) * (1 - Math.exp(-DECAY_RATE_PER_RUN));
    const newSigma = Math.min(p.sigma + sigmaInc, MAX_SIGMA);

    const muClamp = muFromElo(ELO_CUTOFF, newSigma);
    const newMu = muClamp + (p.mu - muClamp) * Math.exp(-DECAY_RATE_PER_RUN);

    console.log(
      `[DECAY] ${p.userId}: Elo ${currentElo}→${calculateElo(newMu, newSigma)} ` +
      `(μ: ${p.mu.toFixed(2)}→${newMu.toFixed(2)}, σ: ${p.sigma.toFixed(2)}→${newSigma.toFixed(2)})`
    );

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
        newElo: calculateElo(newMu, newSigma),
        parameters: JSON.stringify({ daysSinceLastPlayed: Math.floor(msSinceLast / (24 * 60 * 60 * 1000)) })
      });
    } catch (auditError) {
      console.error('Error logging decay change to audit trail:', auditError);
    }

    decayedCount++;
  }

  console.log(`[DECAY] Applied decay to ${decayedCount} players`);
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
    console.log(`📄 Rating decay system active (${config.decayStartDays} day grace period)`);
    
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