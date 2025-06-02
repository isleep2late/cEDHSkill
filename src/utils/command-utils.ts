import {
    CommandInteraction,
    GuildChannel,
    MessageComponentInteraction,
    ModalSubmitInteraction,
    ThreadChannel,
} from 'discord.js';

import { FormatUtils, InteractionUtils } from './index.js';
import { Command } from '../commands/index.js';
import { Permission } from '../models/enum-helpers/index.js';
import { EventData } from '../models/internal-models.js';
import { Lang } from '../services/index.js';

export class CommandUtils {
    public static findCommand(commands: Command[], commandParts: string[]): Command | undefined {
        let found = [...commands];
        let closestMatch: Command | undefined;
        for (let [index, commandPart] of commandParts.entries()) {
            found = found.filter(command => command.names[index] === commandPart);
            if (found.length === 0) {
                return closestMatch;
            }

            if (found.length === 1) {
                return found[0];
            }

            let exactMatch = found.find(command => command.names.length === index + 1);
            if (exactMatch) {
                closestMatch = exactMatch;
            }
        }
        return closestMatch;
    }

    public static async runChecks(
        command: Command,
        intr: CommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
        data: EventData
    ): Promise<boolean> {
        if (command.cooldown) {
            let limited = command.cooldown.take(intr.user.id);
            if (limited) {
                await InteractionUtils.send(
                    intr,
                    Lang.getEmbed('validationEmbeds.cooldownHit', data.lang, {
                        AMOUNT: command.cooldown.amount.toLocaleString(data.lang),
                        INTERVAL: FormatUtils.duration(command.cooldown.interval, data.lang),
                    })
                );
                return false;
            }
        }

        const currentChannel = intr.channel;
        const clientUser = intr.client.user;

        if (currentChannel && (currentChannel instanceof GuildChannel || currentChannel instanceof ThreadChannel)) {
            if (clientUser) {
                const channelPermissions = currentChannel.permissionsFor(clientUser);
                // channelPermissions can be null if the user isn't in the guild context for the channel
                if (channelPermissions && !channelPermissions.has(command.requireClientPerms)) {
                    await InteractionUtils.send(
                        intr,
                        Lang.getEmbed('validationEmbeds.missingClientPerms', data.lang, {
                            PERMISSIONS: command.requireClientPerms
                                .map(perm => `**${Permission.Data[perm].displayName(data.lang)}**`)
                                .join(', '),
                        })
                    );
                    return false;
                }
                // If channelPermissions is null, it implies the bot might not have permissions
                // or the user context is unusual. For now, we only block if permissions are
                // explicitly insufficient. If command.requireClientPerms is empty,
                // !channelPermissions.has([]) would be !true (false), so it passes.
            }
        }

        return true;
    }
}
