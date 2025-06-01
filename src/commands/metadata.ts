import {
    ApplicationCommandType,
    PermissionFlagsBits,
    PermissionsBitField,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    RESTPostAPIContextMenuApplicationCommandsJSONBody,
} from 'discord.js';

import { Args } from './index.js';
import { Language } from '../models/enum-helpers/index.js';
import { Lang } from '../services/index.js';

export const ChatCommandMetadata: {
    [command: string]: RESTPostAPIChatInputApplicationCommandsJSONBody;
} = {
    DEV: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.dev', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.dev'),
        description: Lang.getRef('commandDescs.dev', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.dev'),
        dm_permission: true,
        default_member_permissions: PermissionsBitField.resolve([
            PermissionFlagsBits.Administrator,
        ]).toString(),
        options: [
            {
                ...Args.DEV_COMMAND,
                required: true,
            },
        ],
    },
    HELP: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.help', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.help'),
        description: Lang.getRef('commandDescs.help', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.help'),
        dm_permission: true,
        default_member_permissions: undefined,
        options: [
            {
                ...Args.HELP_OPTION,
                required: true,
            },
        ],
    },
    INFO: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.info', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.info'),
        description: Lang.getRef('commandDescs.info', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.info'),
        dm_permission: true,
        default_member_permissions: undefined,
        options: [
            {
                ...Args.INFO_OPTION,
                required: true,
            },
        ],
    },
    TEST: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.test', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.test'),
        description: Lang.getRef('commandDescs.test', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.test'),
        dm_permission: true,
        default_member_permissions: undefined,
    },
    RANK: { // New Command
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.rank', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.rank'),
        description: Lang.getRef('commandDescs.rank', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.rank'),
        dm_permission: false, // Ranking is typically guild-specific
        default_member_permissions: undefined, // Everyone can use by default, adjust if needed
        options: [
            {
                // Referencing the new Arg we created
                ...Args.RANK_RESULTS_STRING,
            },
        ],
    },
    LIST: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.list', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.list'),
        description: Lang.getRef('commandDescs.list', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.list'),
        dm_permission: false, // List is guild-specific
        default_member_permissions: undefined, // Everyone can use by default
        options: [
            {
                ...Args.LIST_COUNT_OPTION,
            },
        ],
    },
    PLAYERINFO: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.playerinfo', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.playerinfo'),
        description: Lang.getRef('commandDescs.playerinfo', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.playerinfo'),
        dm_permission: true, // Player ratings are global, not guild-specific
        default_member_permissions: undefined, // Everyone can use by default
        options: [
            {
                ...Args.PLAYERINFO_USER,
            },
        ],
    },
    UNDO: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.undo', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.undo'),
        description: Lang.getRef('commandDescs.undo', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.undo'),
        dm_permission: false, // Guild-specific as it refers to guild's last rank
        default_member_permissions: undefined, // Everyone can use by default
        options: [], // No options for undo
    },
};

export const MessageCommandMetadata: {
    [command: string]: RESTPostAPIContextMenuApplicationCommandsJSONBody;
} = {
    VIEW_DATE_SENT: {
        type: ApplicationCommandType.Message,
        name: Lang.getRef('messageCommands.viewDateSent', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('messageCommands.viewDateSent'),
        default_member_permissions: undefined,
        dm_permission: true,
    },
};

export const UserCommandMetadata: {
    [command: string]: RESTPostAPIContextMenuApplicationCommandsJSONBody;
} = {
    VIEW_DATE_JOINED: {
        type: ApplicationCommandType.User,
        name: Lang.getRef('userCommands.viewDateJoined', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('userCommands.viewDateJoined'),
        default_member_permissions: undefined,
        dm_permission: true,
    },
};
