// src/bot.ts
import { initDatabase } from './db/init.js';
import { applyRatingDecay } from './jobs/decay.js';

await initDatabase();

import {
    Client,
    GatewayIntentBits,
    Interaction,
    REST,
    Routes,
    Collection,
    Events,
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageReaction,
    PartialMessageReaction,
    User,
    PartialUser,
    Message,
    Partials,
} from 'discord.js';

import { config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { setAdminOptIn, getAdminOptIn } from './db/match-utils.js';

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

async function main() {
    const commandsPath = path.resolve('./dist/commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = await import(`file://${filePath}`);
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.warn(`[WARNING] The command at ${file} is missing a "data" or "execute" export.`);
        }
    }

    client.once(Events.ClientReady, async () => {
        console.log(`🤖 Logged in as ${client.user?.tag}`);
        await applyRatingDecay();
    });

    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const command = client.commands.get(interaction.commandName);
        if (!command) {
            console.error(`❌ No command matching ${interaction.commandName} found.`);
            return;
        }

        try {
            await command.execute(interaction, client);
        } catch (error) {
            console.error(`💥 Error executing command ${interaction.commandName}:`, error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'There was an error executing this command.', ephemeral: true });
            } else {
                await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
            }
        }
    });

    client.on(Events.MessageReactionAdd, async (
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser
    ) => {
        try {
            if (reaction.partial) await reaction.fetch();
            if (user.partial) await user.fetch();
        } catch (err) {
            console.error('⚠️ Failed to fetch partial reaction or user:', err);
            return;
        }

        if (user.bot) return;
        if (reaction.emoji.name !== '👍') return;

        const messageId = reaction.message.id;
        const pending = client.limboGames.get(messageId);
        if (!pending) return;

        pending.delete(user.id);
        console.log(`✅ ${user.username} confirmed results for message ${messageId}`);

        if (pending.size === 0) {
            client.limboGames.delete(messageId);
            await reaction.message.reply('✅ All players have confirmed. Results are now final!');
        }
    });

    client.on('messageCreate', async (message: Message) => {
        if (message.author.bot || message.guild) return;

        const isAdmin = config.admins.includes(message.author.id);
        const content = message.content.toLowerCase().trim();

        if (!isAdmin) {
            await message.reply("❌ Only registered admins can use this command.");
            return;
        }

        if (content === '!optout') {
            await setAdminOptIn(message.author.id, false);
            await message.reply("✅ You will no longer receive suspicious activity alerts.");
        } else if (content === '!optin') {
            await setAdminOptIn(message.author.id, true);
            await message.reply("✅ You will now receive suspicious activity alerts.");
        }
    });

    await client.login(config.token);
}

main().catch(console.error);
