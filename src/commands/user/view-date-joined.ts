import { DMChannel, PermissionsString, UserContextMenuCommandInteraction } from 'discord.js';
import { RateLimiter } from 'discord.js-rate-limiter';
import { DateTime } from 'luxon';

import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { InteractionUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export class ViewDateJoined implements Command {
    public names = [Lang.getRef('userCommands.viewDateJoined', Language.Default)];
    public cooldown = new RateLimiter(1, 5000);
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];

    public async execute(intr: UserContextMenuCommandInteraction, data: EventData): Promise<void> {
        let joinDate: Date;
        if (!(intr.channel instanceof DMChannel)) {
            if (!intr.guild) {
                // This should ideally not happen for a UserContextMenuCommandInteraction outside of DMs,
                // but we add a guard just in case.
                await InteractionUtils.send(
                    intr,
                    Lang.getEmbed('errorEmbeds.commandNotInGuild', data.lang),
                    true
                );
                return;
            }
            let member = await intr.guild.members.fetch(intr.targetUser.id);

            if (!member.joinedAt) {
                // Member might not have a join date (e.g., if they left and rejoined, or an API glitch)
                await InteractionUtils.send(
                    intr,
                    Lang.getEmbed('errorEmbeds.fetchUserError', data.lang, {
                        TARGET_USER: intr.targetUser.toString(), // intr.targetUser is confirmed not null from the check above
                    }),
                    true
                );
                return;
            }
            joinDate = member.joinedAt;
        } else joinDate = intr.targetUser.createdAt;

        await InteractionUtils.send(
            intr,
            Lang.getEmbed('displayEmbeds.viewDateJoined', data.lang, {
                TARGET: intr.targetUser.toString(),
                DATE: DateTime.fromJSDate(joinDate).toLocaleString(DateTime.DATE_HUGE),
            })
        );
    }
}
