import { Guild } from 'discord.js';
import { createRequire } from 'node:module';

import { EventHandler } from './index.js';
import { Language } from '../models/enum-helpers/index.js';
import { EventDataService, Lang, Logger } from '../services/index.js';
import { ClientUtils, FormatUtils, MessageUtils } from '../utils/index.js';

const require = createRequire(import.meta.url);
let Logs = require('../../lang/logs.json');

export class GuildJoinHandler implements EventHandler {
    constructor(private eventDataService: EventDataService) {}

    public async process(guild: Guild): Promise<void> {
        Logger.info(
            Logs.info.guildJoined
                .replaceAll('{GUILD_NAME}', guild.name)
                .replaceAll('{GUILD_ID}', guild.id)
        );

        let owner = await guild.fetchOwner();

        // Get data from database
        let data = await this.eventDataService.create({
            user: owner?.user,
            guild,
        });

        // Send welcome message to the server's notify channel
        let notifyChannel = await ClientUtils.findNotifyChannel(guild, data.langGuild);
        if (notifyChannel) {
            const helpCommandGuild = await ClientUtils.findAppCommand(
                guild.client,
                Lang.getRef('chatCommands.help', Language.Default)
            );
            await MessageUtils.send(
                notifyChannel,
                Lang.getEmbed('displayEmbeds.welcome', data.langGuild, {
                    CMD_LINK_HELP: helpCommandGuild
                        ? FormatUtils.commandMention(helpCommandGuild)
                        : Lang.getRef('info.commandNotFound', data.langGuild),
                }).setAuthor({
                    name: guild.name,
                    iconURL: guild.iconURL() ?? undefined,
                })
            );
        }

        // Send welcome message to owner
        if (owner) {
            const helpCommandOwner = await ClientUtils.findAppCommand(
                guild.client,
                Lang.getRef('chatCommands.help', Language.Default)
            );
            await MessageUtils.send(
                owner.user,
                Lang.getEmbed('displayEmbeds.welcome', data.lang, {
                    CMD_LINK_HELP: helpCommandOwner
                        ? FormatUtils.commandMention(helpCommandOwner)
                        : Lang.getRef('info.commandNotFound', data.lang),
                }).setAuthor({
                    name: guild.name,
                    iconURL: guild.iconURL() ?? undefined,
                })
            );
        }
    }
}
