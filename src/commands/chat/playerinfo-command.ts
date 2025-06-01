import { ChatInputCommandInteraction, EmbedBuilder, PermissionsString } from 'discord.js';

import { PlayerRating } from '../../db.js'; // Import the Sequelize model instance
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { InteractionUtils, RatingUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export class PlayerInfoCommand implements Command {
    public names = [Lang.getRef('chatCommands.playerinfo', Language.Default)];
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

        const user = intr.options.getUser(
            Lang.getRef('arguments.user', data.lang),
            true
        );

        const playerRecord = await PlayerRating.findOne({ where: { userId: user.id, guildId: guildId } });

        let embed: EmbedBuilder;

        if (playerRecord) {
            const elo = RatingUtils.calculateElo(playerRecord.mu, playerRecord.sigma);
            const wins = playerRecord.wins || 0;
            const losses = playerRecord.losses || 0;
            embed = Lang.getEmbed('displayEmbeds.playerInfoFound', data.lang, {
                USER_TAG: user.tag,
                ELO: elo.toString(),
                SIGMA: playerRecord.sigma.toFixed(4),
                MU: playerRecord.mu.toFixed(4),
                WINS: wins.toString(),
                LOSSES: losses.toString(),
            });
        } else {
            embed = Lang.getEmbed('displayEmbeds.playerInfoUnrated', data.lang, {
                USER_TAG: user.tag,
            });
        }

        await InteractionUtils.send(intr, embed);
    }
}