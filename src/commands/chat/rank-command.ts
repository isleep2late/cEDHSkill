import { ChatInputCommandInteraction, PermissionsString, Locale } from 'discord.js';
import { rating, rate, Rating as OpenSkillRating } from 'openskill';

import { GameConstants } from '../../constants/index.js';
import { PlayerRating } from '../../db.js'; // Import the Sequelize model instance
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { InteractionUtils, RatingUtils, MessageUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export interface ParsedPlayer {
    // Exporting for use in Reaction Handler
    userId: string;
    status: 'w' | 'l'; // Winner or Loser
    initialRating: OpenSkillRating;
    initialElo: number;
    initialWins: number;
    initialLosses: number;
    tag: string; // For display, e.g., <@username> or <@userId>
    newRating: OpenSkillRating; // Store the calculated new rating
    newWins: number;
    newLosses: number;
}

export interface PendingRankUpdate {
    guildId: string;
    playersToUpdate: ParsedPlayer[];
    interaction: ChatInputCommandInteraction; // To edit the original message
    lang: Locale;
    upvoters: Set<string>; // Store user IDs who have upvoted
    status: 'active' | 'disabled_by_undo'; // Status of the pending update
}

export interface LatestPendingRankContext {
    guildId: string;
    messageId: string;
    channelId: string;
    interaction: ChatInputCommandInteraction; // Storing the interaction to be able to edit its reply later
}

export interface LatestConfirmedRankOpDetails {
    guildId: string;
    messageId: string; // Message ID of the confirmed rank embed
    channelId: string; // Channel ID of the confirmed rank embed
    players: ParsedPlayer[]; // The state of players *before* this confirmed operation
    timestamp: number;
}

export class RankCommand implements Command {
    public static pendingRankUpdates = new Map<string, PendingRankUpdate>(); // messageId -> PendingRankUpdate
    public static latestPendingRankContext: LatestPendingRankContext | null = null;
    public static latestConfirmedRankOpDetails: LatestConfirmedRankOpDetails | null = null;

    public names = [Lang.getRef('chatCommands.rank', Language.Default)];
    public deferType = CommandDeferType.PUBLIC;
    public requireClientPerms: PermissionsString[] = ['SendMessages', 'EmbedLinks'];

    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        // When a new rank command is initiated, any previous "latest confirmed" is no longer the "latest" for undo.
        // And this new one becomes the "latest pending".
        RankCommand.latestConfirmedRankOpDetails = null;

        if (!intr.guild) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('errorEmbeds.commandNotInGuild', data.lang),
                true
            );
            return;
        }
        const guildId = intr.guild.id;

        const resultsInput = intr.options.getString(
            Lang.getRef('arguments.results', data.lang),
            true
        );

        const participantRegex = /<@!?(\d+)>_*\s+([wlWL])/gi;
        let match;
        const parsedParticipantsInput: Array<{ userId: string; status: 'w' | 'l'; tag: string }> =
            [];

        while ((match = participantRegex.exec(resultsInput)) !== null) {
            parsedParticipantsInput.push({
                userId: match[1],
                status: match[2].toLowerCase() as 'w' | 'l',
                tag: `<@${match[1]}>`,
            });
        }

        if (parsedParticipantsInput.length === 0 && resultsInput.trim() !== '') {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('validationEmbeds.rankErrorParsing', data.lang),
                true
            );
            return;
        }

        if (parsedParticipantsInput.length < 2) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('validationEmbeds.rankNotEnoughPlayers', data.lang),
                true
            );
            return;
        }

        const playersData: ParsedPlayer[] = [];
        for (const pInput of parsedParticipantsInput) {
            const user = await intr.client.users.fetch(pInput.userId).catch(() => null);
            const displayUserTag = user ? user.tag : pInput.tag; // Use user.tag for better display

            let dbRating = await PlayerRating.findOne({
                where: { userId: pInput.userId, guildId: guildId },
            });
            let osRating: OpenSkillRating;
            let wins = 0;
            let losses = 0;

            if (dbRating) {
                osRating = rating({ mu: dbRating.mu, sigma: dbRating.sigma });
                wins = dbRating.wins || 0; // Default to 0 if null/undefined
                losses = dbRating.losses || 0; // Default to 0 if null/undefined
            } else {
                osRating = rating(); // Default openskill rating
            }
            const initialElo = RatingUtils.calculateElo(osRating.mu, osRating.sigma);
            playersData.push({
                userId: pInput.userId,
                status: pInput.status,
                initialRating: osRating,
                initialElo: initialElo,
                initialWins: wins,
                initialLosses: losses,
                tag: displayUserTag,
                newRating: osRating, // Placeholder, will be updated
                newWins: wins, // Placeholder
                newLosses: losses, // Placeholder
            });
        }

        const winners = playersData.filter(p => p.status === 'w');
        const losers = playersData.filter(p => p.status === 'l');

        if (winners.length === 0 || losers.length === 0) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('validationEmbeds.rankInvalidOutcome', data.lang),
                true
            );
            return;
        }

        const winningTeamRatings: OpenSkillRating[] = winners.map(p => p.initialRating);
        const losingTeamRatings: OpenSkillRating[] = losers.map(p => p.initialRating);

        const [updatedWinningTeamRatings, updatedLosingTeamRatings] = rate([
            winningTeamRatings,
            losingTeamRatings,
        ]);

        // Prepare playersToUpdate with new ratings and W/L but don't save yet
        const playersToUpdate: ParsedPlayer[] = [];

        for (let i = 0; i < winners.length; i++) {
            const player = winners[i];
            player.newRating = updatedWinningTeamRatings[i];
            player.newWins = player.initialWins + 1;
            player.newLosses = player.initialLosses; // Losses don't change for winners
            playersToUpdate.push(player);
        }

        for (let i = 0; i < losers.length; i++) {
            const player = losers[i];
            player.newRating = updatedLosingTeamRatings[i];
            player.newWins = player.initialWins; // Wins don't change for losers
            player.newLosses = player.initialLosses + 1;
            playersToUpdate.push(player);
        }

        const provisionalEmbed = Lang.getEmbed('displayEmbeds.rankProvisional', data.lang, {
            UPVOTES_REQUIRED: GameConstants.RANK_UPVOTES_REQUIRED.toString(),
            UPVOTE_EMOJI: GameConstants.RANK_UPVOTE_EMOJI,
            CURRENT_UPVOTES: '0',
        });
        provisionalEmbed.setTitle(Lang.getRef('fields.provisionalRatings', data.lang));

        for (const player of playersToUpdate) {
            const newElo = RatingUtils.calculateElo(player.newRating.mu, player.newRating.sigma);
            const outcome =
                player.status === 'w'
                    ? Lang.getRef('terms.winner', data.lang)
                    : Lang.getRef('terms.loser', data.lang);
            provisionalEmbed.addFields({
                name: `${player.tag} (${outcome})`,
                value: `Old: Elo=${player.initialElo}, μ=${player.initialRating.mu.toFixed(2)}, σ=${player.initialRating.sigma.toFixed(2)}, W/L: ${player.initialWins}/${player.initialLosses}\nNew: Elo=${newElo}, μ=${player.newRating.mu.toFixed(2)}, σ=${player.newRating.sigma.toFixed(2)}, W/L: ${player.newWins}/${player.newLosses}`,
                inline: false,
            });
        }

        const sentMessage = await InteractionUtils.send(intr, provisionalEmbed);

        if (sentMessage) {
            try {
                await MessageUtils.react(sentMessage, GameConstants.RANK_UPVOTE_EMOJI);
                RankCommand.pendingRankUpdates.set(sentMessage.id, {
                    guildId,
                    playersToUpdate,
                    interaction: intr,
                    lang: data.lang,
                    upvoters: new Set(),
                    status: 'active', // New pending ranks are active by default
                });

                // Set this as the latest pending rank context for the /undo command
                RankCommand.latestPendingRankContext = {
                    guildId: guildId,
                    messageId: sentMessage.id,
                    channelId: sentMessage.channelId,
                    interaction: intr,
                };
            } catch (error) {
                console.error('Failed to add initial reaction or set pending update:', error);
                // Optionally, inform the user that the confirmation setup failed
                await InteractionUtils.send(
                    intr,
                    Lang.getEmbed('errorEmbeds.rankSetupFailed', data.lang),
                    true
                );
                // Clean up if necessary
                if (RankCommand.pendingRankUpdates.has(sentMessage.id)) {
                    RankCommand.pendingRankUpdates.delete(sentMessage.id);
                }
            }
        } else {
            // Handle case where message sending failed
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('errorEmbeds.messageSendFailed', data.lang),
                true
            );
        }
    }
}
