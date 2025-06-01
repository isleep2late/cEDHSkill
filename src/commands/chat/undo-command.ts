import { ChatInputCommandInteraction, PermissionsString, EmbedBuilder, Message, resolveColor as discordResolveColor } from 'discord.js';
import { Command, CommandDeferType } from '../index.js';
import { PlayerRating } from '../../db.js';
import { Lang } from '../../services/index.js';
import { InteractionUtils, RatingUtils, MessageUtils } from '../../utils/index.js';
import { EventData } from '../../models/internal-models.js';
import { Language } from '../../models/enum-helpers/index.js';
import { RankCommand, PendingRankUpdate, ParsedPlayer } from './rank-command.js'; // To access static properties
import { GameConstants } from '../../constants/index.js';

export class UndoCommand implements Command {
    public names = [Lang.getRef('chatCommands.undo', Language.Default)];
    public deferType = CommandDeferType.PUBLIC;
    public requireClientPerms: PermissionsString[] = ['SendMessages', 'EmbedLinks'];

    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        if (!intr.guild) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('errorEmbeds.commandNotInGuild', data.lang),
                true
            );
            return;
        }
        const guildId = intr.guild.id;

        // Scenario 1: Last rank command was confirmed and ratings were updated
        if (RankCommand.latestConfirmedRankOpDetails && RankCommand.latestConfirmedRankOpDetails.guildId === guildId) {
            const confirmedOp = RankCommand.latestConfirmedRankOpDetails;
            const playersToRevert: ParsedPlayer[] = confirmedOp.players;

            const undoEmbed = Lang.getEmbed('displayEmbeds.undoConfirmedTitle', data.lang);
            undoEmbed.setTitle(Lang.getRef('fields.undoConfirmedTitle', data.lang));
            undoEmbed.setDescription(Lang.getRef('undoMessages.confirmedDescriptionText', data.lang));

            try {
                for (const player of playersToRevert) {
                    await PlayerRating.upsert({
                        userId: player.userId,
                        guildId: guildId,
                        mu: player.initialRating.mu,
                        sigma: player.initialRating.sigma,
                        wins: player.initialWins,
                        losses: player.initialLosses,
                    });

                    const currentElo = RatingUtils.calculateElo(player.newRating.mu, player.newRating.sigma);
                    // initialElo is what we are reverting to
                    undoEmbed.addFields({
                        name: `${player.tag}`,
                        value: Lang.getRef('undoMessages.playerChangeFormat', data.lang, {
                            OLD_ELO: currentElo.toString(),
                            NEW_ELO: player.initialElo.toString(),
                            OLD_MU: player.newRating.mu.toFixed(2),
                            NEW_MU: player.initialRating.mu.toFixed(2),
                            OLD_SIGMA: player.newRating.sigma.toFixed(2),
                            NEW_SIGMA: player.initialRating.sigma.toFixed(2),
                            OLD_WINS: player.newWins.toString(),
                            NEW_WINS: player.initialWins.toString(),
                            OLD_LOSSES: player.newLosses.toString(),
                            NEW_LOSSES: player.initialLosses.toString(),
                        }),
                        inline: false,
                    });
                }

                // If a message ID was stored for the confirmed rank, try to edit it
                if (confirmedOp.messageId && confirmedOp.channelId) {
                    try {
                        const channel = await intr.client.channels.fetch(confirmedOp.channelId);
                        if (channel?.isTextBased()) {
                            const originalMessage = await channel.messages.fetch(confirmedOp.messageId);
                            if (originalMessage) {
                                const undidEmbed = new EmbedBuilder(originalMessage.embeds[0]?.toJSON()); // Copy existing
                                undidEmbed.setTitle(Lang.getRef('fields.rankUndoneTitle', data.lang));
                                undidEmbed.setDescription(Lang.getRef('displayEmbeds.rankUndoneDescription', data.lang));
                                undidEmbed.setColor(Lang.getCom('colors.warning') as `#${string}`); // A neutral/warning color
                                await MessageUtils.edit(originalMessage, { embeds: [undidEmbed] });
                                await MessageUtils.clearReactions(originalMessage);
                            }
                        }
                    } catch (error) {
                        console.warn(`UndoCommand: Could not edit original confirmed rank message ${confirmedOp.messageId}:`, error);
                        // Non-critical, proceed with sending the undo confirmation
                    }
                }


                await InteractionUtils.send(intr, undoEmbed);
                RankCommand.latestConfirmedRankOpDetails = null; // Clear after successful undo
                RankCommand.latestPendingRankContext = null; // Also clear pending if a confirmed one was undone.
            } catch (error) {
                console.error('Error during /undo of confirmed rank:', error);
                await InteractionUtils.send(intr, Lang.getEmbed('errorEmbeds.undoFailed', data.lang), true);
            }
            return;
        }

        // Scenario 2: Last rank command is still pending (not fully upvoted)
        if (RankCommand.latestPendingRankContext && RankCommand.latestPendingRankContext.guildId === guildId) {
            const pendingCtx = RankCommand.latestPendingRankContext;
            const pendingUpdate = RankCommand.pendingRankUpdates.get(pendingCtx.messageId);

            if (pendingUpdate && pendingUpdate.status !== 'disabled_by_undo') {
                pendingUpdate.status = 'disabled_by_undo';
                RankCommand.pendingRankUpdates.set(pendingCtx.messageId, pendingUpdate); // Update the map

                try {
                    const originalMessage = await pendingCtx.interaction.fetchReply();
                    if (originalMessage && originalMessage.embeds.length > 0) {
                        const disabledEmbed = new EmbedBuilder(originalMessage.embeds[0].toJSON()); // Copy existing
                        disabledEmbed.setTitle(Lang.getRef('fields.rankDisabledTitle', data.lang));
                        disabledEmbed.setDescription(
                            Lang.getRef('undoMessages.rankDisabledDescriptionText', data.lang, {
                                UPVOTE_EMOJI: GameConstants.RANK_UPVOTE_EMOJI,
                            })
                        );
                        // Using a specific grey color hex code as 'grey' might not be in discord.js's default ColorResolvable
                        disabledEmbed.setColor(0x808080); 

                        await InteractionUtils.editReply(pendingCtx.interaction, disabledEmbed);
                        await MessageUtils.clearReactions(originalMessage as Message); // Clear reactions

                        await InteractionUtils.send(intr, Lang.getEmbed('displayEmbeds.undoPendingSuccess', data.lang));
                        RankCommand.latestPendingRankContext = null; // Clear after successful disable
                    } else {
                        throw new Error('Original pending message or its embed not found.');
                    }
                } catch (error) {
                    console.error('Error disabling pending rank via /undo:', error);
                    // Attempt to roll back status if edit failed
                    pendingUpdate.status = 'active';
                     RankCommand.pendingRankUpdates.set(pendingCtx.messageId, pendingUpdate);
                    await InteractionUtils.send(intr, Lang.getEmbed('errorEmbeds.undoFailed', data.lang), true);
                }
            } else if (pendingUpdate && pendingUpdate.status === 'disabled_by_undo') {
                // It was already disabled
                await InteractionUtils.send(intr, Lang.getEmbed('displayEmbeds.undoAlreadyDisabled', data.lang), true);
            } else {
                // Pending context existed, but no matching entry in pendingRankUpdates map (should be rare)
                 await InteractionUtils.send(intr, Lang.getEmbed('displayEmbeds.undoNothingToUndo', data.lang), true);
            }
            return;
        }

        // Scenario 3: Nothing to undo
        await InteractionUtils.send(intr, Lang.getEmbed('displayEmbeds.undoNothingToUndo', data.lang), true);
    }
}

// Removed local resolveColor helper, using discordResolveColor from discord.js directly