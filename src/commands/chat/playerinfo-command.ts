import { ChatInputCommandInteraction, EmbedBuilder, PermissionsString, User } from 'discord.js';
import { Command, CommandDeferType } from '../index.js';
import { PlayerRating } from '../../db.js'; // Import the Sequelize model instance
import { Lang } from '../../services/index.js';
import { InteractionUtils } from '../../utils/index.js';
import { EventData } from '../../models/internal-models.js';
import { Language } from '../../models/enum-helpers/index.js';

export class PlayerInfoCommand implements Command {
    public names = [Lang.getRef('chatCommands.playerinfo', Language.Default)];
    public deferType = CommandDeferType.PUBLIC;
    public requireClientPerms: PermissionsString[] = ['SendMessages', 'EmbedLinks'];

    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        const user = intr.options.getUser(
            Lang.getRef('arguments.user', data.lang), // Use data.lang for argument name if localized
            true // Argument is required
        );

        const playerRecord = await PlayerRating.findOne({ where: { userId: user.id } });

        let embed: EmbedBuilder;

        if (playerRecord) {
            embed = Lang.getEmbed('displayEmbeds.playerInfoFound', data.lang, {
                USER_TAG: user.tag,
                SIGMA: playerRecord.sigma.toFixed(4),
                MU: playerRecord.mu.toFixed(4),
            });
        } else {
            embed = Lang.getEmbed('displayEmbeds.playerInfoUnrated', data.lang, {
                USER_TAG: user.tag,
            });
        }

        await InteractionUtils.send(intr, embed);
    }
}