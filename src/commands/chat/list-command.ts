import { ChatInputCommandInteraction, EmbedBuilder, PermissionsString } from 'discord.js';

import { DiscordLimits } from '../../constants/index.js';
import { PlayerRating } from '../../db.js'; // Import the Sequelize model instance
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { InteractionUtils, RatingUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export class ListCommand implements Command {
    public names = [Lang.getRef('chatCommands.list', Language.Default)];
    public deferType = CommandDeferType.PUBLIC;
    public requireClientPerms: PermissionsString[] = ['SendMessages', 'EmbedLinks'];

    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        if (!intr.guild) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('errorEmbeds.guildOnlyCommand', data.lang),
                true
            );
            return;
        }
        const guildId = intr.guild.id;

        const count =
            intr.options.getInteger(Lang.getRef('arguments.count', data.lang)) ?? 10;

        if (count <= 0) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('validationEmbeds.listCountInvalid', data.lang),
                true
            );
            return;
        }

        const players = await PlayerRating.findAll({
            where: { guildId: guildId },
            order: [['mu', 'DESC']],
            limit: Math.min(count, DiscordLimits.FIELDS_PER_EMBED), // Discord embed field limit
        });

        if (players.length === 0) {
            await InteractionUtils.send(
                intr,
                Lang.getEmbed('displayEmbeds.listNoPlayers', data.lang, {
                    GUILD_NAME: intr.guild.name,
                })
            );
            return;
        }

        const embed = Lang.getEmbed('displayEmbeds.listPlayersTitle', data.lang, {
            GUILD_NAME: intr.guild.name,
        });

        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            let userTag = player.userId; // Default to ID if user fetch fails
            try {
                const user = await intr.client.users.fetch(player.userId);
                userTag = user.tag;
            } catch (error) {
                // User might not be fetchable, keep userTag as ID
            }

            const wins = player.wins || 0;
            const losses = player.losses || 0;

            embed.addFields({
                name: `${i + 1}. ${userTag}`,
                value: `Elo: ${RatingUtils.calculateElo(player.mu, player.sigma)}, μ: ${player.mu.toFixed(2)}, σ: ${player.sigma.toFixed(2)}, W/L: ${wins}/${losses}`,
                inline: false,
            });
        }

        if (count > DiscordLimits.FIELDS_PER_EMBED && players.length === DiscordLimits.FIELDS_PER_EMBED) {
            const footerText = Lang.getRef('displayEmbeds.listFooterTruncated', data.lang, {
                SHOWN_COUNT: DiscordLimits.FIELDS_PER_EMBED.toString(),
                REQUESTED_COUNT: count.toString(),
            });
            const currentFooter = embed.data.footer?.text;
            embed.setFooter({ text: currentFooter ? `${currentFooter} - ${footerText}` : footerText });
        }

        await InteractionUtils.send(intr, embed);
    }
}