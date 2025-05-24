import { ChatInputCommandInteraction, PermissionsString, EmbedBuilder } from 'discord.js';
import { rating, rate, Rating as OpenSkillRating } from 'openskill';
import { Command, CommandDeferType } from '../index.js';
import { PlayerRating } from '../../db.js'; // Import the Sequelize model instance
import { Lang } from '../../services/index.js';
import { InteractionUtils } from '../../utils/index.js';
import { EventData } from '../../models/internal-models.js';
import { Language } from '../../models/enum-helpers/index.js';

interface ParsedPlayer {
    userId: string;
    status: 'w' | 'l'; // Winner or Loser
    initialRating: OpenSkillRating;
    tag: string; // For display, e.g., <@username> or <@userId>
}

export class RankCommand implements Command {
    public names = [Lang.getRef('chatCommands.rank', Language.Default)];
    public deferType = CommandDeferType.PUBLIC;
    public requireClientPerms: PermissionsString[] = ['SendMessages', 'EmbedLinks'];

    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        const resultsInput = intr.options.getString(
            Lang.getRef('arguments.results', data.lang), // Use data.lang for argument name if localized
            true // Argument is required
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
                Lang.getEmbed('displayEmbeds.rankErrorParsing', data.lang),
                true
            );
            return;
        }

        if (parsedParticipantsInput.length < 2) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('displayEmbeds.rankNotEnoughPlayers', data.lang),
                true
            );
            return;
        }

        const playersData: ParsedPlayer[] = [];
        for (const pInput of parsedParticipantsInput) {
            const user = await intr.client.users.fetch(pInput.userId).catch(() => null);
            // pInput.tag is already in the format <@userId> from the initial regex parsing.
            // Use this as a fallback if the user cannot be fetched or has no username.
            const displayUserTag = user ? `<@${user.username}>` : pInput.tag;

            let dbRating = await PlayerRating.findOne({ where: { userId: pInput.userId } });
            let osRating: OpenSkillRating;
            if (dbRating) {
                osRating = rating({ mu: dbRating.mu, sigma: dbRating.sigma });
            } else {
                osRating = rating(); // Default openskill rating
            }
            playersData.push({
                userId: pInput.userId,
                status: pInput.status,
                initialRating: osRating,
                tag: displayUserTag, // Use the fetched username in the desired format
            });
        }

        const winners = playersData.filter(p => p.status === 'w');
        const losers = playersData.filter(p => p.status === 'l');

        if (winners.length === 0 || losers.length === 0) {
            // This check ensures there's at least one winner AND one loser.
            // If a game can have multiple "winning" teams (e.g., 1st, 2nd place both "win" over 3rd, 4th)
            // or if all players are part of one large winning/losing group (e.g. co-op win/loss)
            // this logic might need adjustment based on how `openskill.rate` handles ranks/scores.
            // For a simple W/L, this check is appropriate.
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('displayEmbeds.rankInvalidOutcome', data.lang),
                true
            );
            return;
        }

        const winningTeamRatings: OpenSkillRating[] = winners.map(p => p.initialRating);
        const losingTeamRatings: OpenSkillRating[] = losers.map(p => p.initialRating);

        // The 'rate' function expects an array of teams, where each team is an array of player ratings.
        // The order of teams in the outer array matters for ranking (lower index = better rank).
        const [updatedWinningTeamRatings, updatedLosingTeamRatings] = rate([
            winningTeamRatings, // Team of winners (rank 1)
            losingTeamRatings, // Team of losers (rank 2)
        ]);

        const responseEmbed = Lang.getEmbed('displayEmbeds.rankSuccess', data.lang);
        responseEmbed.setTitle(Lang.getRef('fields.updatedRatings', data.lang)); // Set title explicitly if needed

        for (let i = 0; i < winners.length; i++) {
            const player = winners[i];
            const newRating = updatedWinningTeamRatings[i];
            await PlayerRating.upsert({
                userId: player.userId,
                mu: newRating.mu,
                sigma: newRating.sigma,
            });
            responseEmbed.addFields({
                name: `${player.tag} (Winner)`,
                value: `Old: μ=${player.initialRating.mu.toFixed(2)}, σ=${player.initialRating.sigma.toFixed(2)}\nNew: μ=${newRating.mu.toFixed(2)}, σ=${newRating.sigma.toFixed(2)}`,
                inline: false,
            });
        }

        for (let i = 0; i < losers.length; i++) {
            const player = losers[i];
            const newRating = updatedLosingTeamRatings[i];
            await PlayerRating.upsert({
                userId: player.userId,
                mu: newRating.mu,
                sigma: newRating.sigma,
            });
            responseEmbed.addFields({
                name: `${player.tag} (Loser)`,
                value: `Old: μ=${player.initialRating.mu.toFixed(2)}, σ=${player.initialRating.sigma.toFixed(2)}\nNew: μ=${newRating.mu.toFixed(2)}, σ=${newRating.sigma.toFixed(2)}`,
                inline: false,
            });
        }

        await InteractionUtils.send(intr, responseEmbed);
    }
}
