import { Message, MessageReaction, User, EmbedBuilder } from 'discord.js';

import { Reaction } from './reaction.js';
import { RankCommand } from '../commands/chat/rank-command.js';
import { GameConstants } from '../constants/index.js';
import { PlayerRating } from '../db.js';
import { EventData } from '../models/internal-models.js';
import { Lang } from '../services/index.js';
import { InteractionUtils, MessageUtils, RatingUtils } from '../utils/index.js';

export class RankConfirmationReaction implements Reaction {
    public emoji = GameConstants.RANK_UPVOTE_EMOJI;
    public requireGuild = true;
    public requireSentByClient = true; // Only react to messages sent by the bot
    public requireEmbedAuthorTag = false; // Bot messages won't have a user author tag

    public async execute(
        msgReaction: MessageReaction,
        msg: Message,
        reactor: User,
        _data: EventData
    ): Promise<void> {
        // Check if this message has a pending rank update
        const pendingUpdate = RankCommand.pendingRankUpdates.get(msg.id);
        if (!pendingUpdate || pendingUpdate.status === 'disabled_by_undo') {
            // If no pending update, or if it's been disabled by /undo, do nothing
            return;
        }

        // Ensure the reaction is the correct one, though our emoji filter should handle this
        if (msgReaction.emoji.name !== GameConstants.RANK_UPVOTE_EMOJI) {
            return;
        }

        // Add the reactor to the set of upvoters if they haven't upvoted already
        if (pendingUpdate.upvoters.has(reactor.id)) {
            // User has already upvoted, optionally remove their reaction to allow re-vote, or just ignore
            // For now, we'll just ignore it to prevent spamming and simplify logic.
            // If you want to allow vote changes, you'd need to handle reaction removal as well.
            return;
        }
        pendingUpdate.upvoters.add(reactor.id);

        const currentUpvotes = pendingUpdate.upvoters.size;

        if (currentUpvotes >= GameConstants.RANK_UPVOTES_REQUIRED) {
            // Threshold met, finalize the update
            try {
                for (const player of pendingUpdate.playersToUpdate) {
                    await PlayerRating.upsert({
                        userId: player.userId,
                        guildId: pendingUpdate.guildId,
                        mu: player.newRating.mu,
                        sigma: player.newRating.sigma,
                        wins: player.newWins,
                        losses: player.newLosses,
                    });
                }

                const confirmedEmbed = Lang.getEmbed('displayEmbeds.rankConfirmed', pendingUpdate.lang);
                confirmedEmbed.setTitle(Lang.getRef('fields.confirmedRatings', pendingUpdate.lang));

                for (const player of pendingUpdate.playersToUpdate) {
                    const newElo = RatingUtils.calculateElo(player.newRating.mu, player.newRating.sigma);
                    const outcome = player.status === 'w' ? Lang.getRef('terms.winner', pendingUpdate.lang) : Lang.getRef('terms.loser', pendingUpdate.lang);
                    confirmedEmbed.addFields({
                        name: `${player.tag} (${outcome})`,
                        value: `Old: Elo=${player.initialElo}, μ=${player.initialRating.mu.toFixed(2)}, σ=${player.initialRating.sigma.toFixed(2)}, W/L: ${player.initialWins}/${player.initialLosses}\nNew: Elo=${newElo}, μ=${player.newRating.mu.toFixed(2)}, σ=${player.newRating.sigma.toFixed(2)}, W/L: ${player.newWins}/${player.newLosses}`,
                        inline: false,
                    });
                }

                await InteractionUtils.editReply(pendingUpdate.interaction, confirmedEmbed);

                // Store details for potential /undo
                RankCommand.latestConfirmedRankOpDetails = {
                    guildId: pendingUpdate.guildId,
                    messageId: msg.id,
                    channelId: msg.channelId,
                    players: pendingUpdate.playersToUpdate.map(p => ({
                        // Store a deep copy of player data *before* this update was applied
                        // The 'newRating', 'newWins', 'newLosses' on playersToUpdate are the state *after* this rank.
                        // The 'initialRating', 'initialWins', 'initialLosses' are the state *before* this rank.
                        userId: p.userId,
                        status: p.status, // Status in this specific game
                        initialRating: p.initialRating,
                        initialElo: p.initialElo,
                        initialWins: p.initialWins,
                        initialLosses: p.initialLosses,
                        tag: p.tag,
                        // For undo, 'newRating' will be what we revert *from*,
                        // and 'initialRating' is what we revert *to*.
                        newRating: p.newRating, // This is the state 'after' this confirmed rank
                        newWins: p.newWins,
                        newLosses: p.newLosses,
                    })),
                    timestamp: Date.now(),
                };
                RankCommand.latestPendingRankContext = null; // This rank is no longer pending

                RankCommand.pendingRankUpdates.delete(msg.id); // Clean up
                await MessageUtils.clearReactions(msg); // Clear all reactions
            } catch (error) {
                console.error('Failed to finalize rank update or edit message:', error);
                // Try to inform the user about the failure
                const errorEmbed = Lang.getEmbed('errorEmbeds.rankUpdateFailed', pendingUpdate.lang);
                try {
                    await InteractionUtils.editReply(pendingUpdate.interaction, errorEmbed);
                } catch (editError) {
                    console.error('Failed to send rank update failure message:', editError);
                    // Fallback: send a new message if editing fails
                    await InteractionUtils.send(pendingUpdate.interaction, errorEmbed, true);
                }
                // Optionally, keep the pending update for manual intervention or remove it
                RankCommand.pendingRankUpdates.delete(msg.id);
            }
        } else {
            // Threshold not met, update the message with the current count
            const originalEmbedData = msg.embeds[0]?.toJSON(); // Get data from the current embed
            if (originalEmbedData) {
                const updatedEmbed = new EmbedBuilder(originalEmbedData);
                updatedEmbed.setDescription(
                    Lang.getRef('rankMessages.updateProvisionalDesc', pendingUpdate.lang, {
                        UPVOTES_REQUIRED: GameConstants.RANK_UPVOTES_REQUIRED.toString(),
                        UPVOTE_EMOJI: GameConstants.RANK_UPVOTE_EMOJI,
                        CURRENT_UPVOTES: currentUpvotes.toString(),
                    })
                );

                try {
                    await InteractionUtils.editReply(pendingUpdate.interaction, updatedEmbed);
                } catch (error) {
                    console.error('Failed to update provisional rank message with upvote count:', error);
                     // If editing the original interaction reply fails, try editing the message directly
                    try {
                        await MessageUtils.edit(msg, { embeds: [updatedEmbed] });
                    } catch (messageEditError) {
                        console.error('Failed to edit message directly with upvote count:', messageEditError);
                    }
                }
            }
        }
    }
}