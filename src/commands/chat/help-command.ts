import { ChatInputCommandInteraction, EmbedBuilder, PermissionsString } from 'discord.js';

import { HelpOption } from '../../enums/index.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { ClientUtils, FormatUtils, InteractionUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export class HelpCommand implements Command {
    public names = [Lang.getRef('chatCommands.help', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];
    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        let args = {
            option: intr.options.getString(
                Lang.getRef('arguments.option', Language.Default)
            ) as HelpOption,
        };

        let embed: EmbedBuilder;
        switch (args.option) {
            case HelpOption.CONTACT_SUPPORT: {
                embed = Lang.getEmbed('displayEmbeds.helpContactSupport', data.lang);
                break;
            }
            case HelpOption.COMMANDS: {
                const testCommand = await ClientUtils.findAppCommand(
                    intr.client,
                    Lang.getRef('chatCommands.test', Language.Default)
                );
                const infoCommand = await ClientUtils.findAppCommand(
                    intr.client,
                    Lang.getRef('chatCommands.info', Language.Default)
                );

                embed = Lang.getEmbed('displayEmbeds.helpCommands', data.lang, {
                    CMD_LINK_TEST: testCommand
                        ? FormatUtils.commandMention(testCommand)
                        : Lang.getRef('info.commandNotFound', data.lang),
                    CMD_LINK_INFO: infoCommand
                        ? FormatUtils.commandMention(infoCommand)
                        : Lang.getRef('info.commandNotFound', data.lang),
                });
                break;
            }
            default: {
                return;
            }
        }

        await InteractionUtils.send(intr, embed);
    }
}
