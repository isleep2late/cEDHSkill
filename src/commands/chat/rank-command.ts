import { ChatInputCommandInteraction, PermissionsString, EmbedBuilder } from 'discord.js';
import { rating, rate, Rating as OpenSkillRating } from 'openskill';
import { Command, CommandDeferType } from '../index.js';
import { PlayerRating } from '../../db.js'; // Import the Sequelize model instance
import { Lang } from '../../services/index.js';
import { InteractionUtils, RatingUtils } from '../../utils/index.js';
import { EventData } from '../../models/internal-models.js';
import { Language } from '../../models/enum-helpers/index.js';

interface ParsedPlayer {
    userId: string;
    status: 'w' | 'l'; // Winner or Loser
    initialRating: OpenSkillRating;
    initialElo: number;
    tag: string; // For display, e.g., <@username> or <@userId>
}

export class RankCommand implements Command {
    public names = [Lang.getRef('chatCommands.rank', Language.Default)];
    public deferType = CommandDeferType.PUBLIC;
    public requireClientPerms: PermissionsString[] = ['SendMessages', 'EmbedLinks'];

    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        if (!intr.guild) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('errorEmbeds.commandNotInGuild', data.lang), // Assuming you'll add this embed key
                true
            );
            return;
        }
        const guildId = intr.guild.id;

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
            const displayUserTag = user ? `<@${user.username}>` : pInput.tag;

            let dbRating = await PlayerRating.findOne({ where: { userId: pInput.userId, guildId: guildId } });
            let osRating: OpenSkillRating;
            if (dbRating) {
                osRating = rating({ mu: dbRating.mu, sigma: dbRating.sigma });
            } else {
                osRating = rating(); // Default openskill rating
            }
            const initialElo = RatingUtils.calculateElo(osRating.mu, osRating.sigma);
            playersData.push({
                userId: pInput.userId,
                status: pInput.status,
                initialRating: osRating,
                initialElo: initialElo,
                tag: displayUserTag,
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

        const responseEmbed = Lang.getEmbed('displayEmbeds.rankSuccess', data.lang);
        responseEmbed.setTitle(Lang.getRef('fields.updatedRatings', data.lang));

        for (let i = 0; i < winners.length; i++) {
            const player = winners[i];
            const newRating = updatedWinningTeamRatings[i];
            await PlayerRating.upsert({
                userId: player.userId,
                guildId: guildId, // Add guildId
                mu: newRating.mu,
                sigma: newRating.sigma,
            });
            const newElo = RatingUtils.calculateElo(newRating.mu, newRating.sigma);
            responseEmbed.addFields({
                name: `${player.tag} (Winner)`,
                value: `Old: Elo=${player.initialElo}, μ=${player.initialRating.mu.toFixed(2)}, σ=${player.initialRating.sigma.toFixed(2)}\nNew: Elo=${newElo}, μ=${newRating.mu.toFixed(2)}, σ=${newRating.sigma.toFixed(2)}`,
                inline: false,
            });
        }

        for (let i = 0; i < losers.length; i++) {
            const player = losers[i];
            const newRating = updatedLosingTeamRatings[i];
            await PlayerRating.upsert({
                userId: player.userId,
                guildId: guildId, // Add guildId
                mu: newRating.mu,
                sigma: newRating.sigma,
            });
            const newElo = RatingUtils.calculateElo(newRating.mu, newRating.sigma);
            responseEmbed.addFields({
                name: `${player.tag} (Loser)`,
                value: `Old: Elo=${player.initialElo}, μ=${player.initialRating.mu.toFixed(2)}, σ=${player.initialRating.sigma.toFixed(2)}\nNew: Elo=${newElo}, μ=${newRating.mu.toFixed(2)}, σ=${newRating.sigma.toFixed(2)}`,
                inline: false,
            });
        }

        await InteractionUtils.send(intr, responseEmbed);
    }
}