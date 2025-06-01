import {
    ChannelType,
    CommandInteraction,
    GuildChannel,
    GuildMember,
    PermissionFlagsBits,
    PermissionsBitField,
    ThreadChannel,
    User,
    ClientUser, // Added
    TextChannel, // Added
    Client, // Added
    CommandInteractionOptionResolver, // Added
} from 'discord.js';
import { vi } from 'vitest';

/**
 * Creates a mock Discord.js User that correctly passes instanceof checks
 */
export function createMockUser(overrides: Partial<User> = {}): User {
    // Create base object with properties we need
    const baseUser = {
        id: '123456789012345678',
        username: 'TestUser',
        discriminator: '0000',
        tag: 'TestUser#0000',
        displayAvatarURL: vi.fn().mockReturnValue('https://example.com/avatar.png'),
        bot: false,
        system: false,
        flags: { bitfield: 0 },
        createdAt: new Date(),
        createdTimestamp: Date.now(),
        // Common methods
        send: vi.fn().mockResolvedValue({}),
        fetch: vi.fn().mockImplementation(function () {
            return Promise.resolve(this);
        }),
        toString: vi.fn().mockReturnValue('<@123456789012345678>'),
    };

    // Add overrides
    Object.assign(baseUser, overrides);

    // Create a properly structured mock that will pass instanceof checks
    const mockUser = Object.create(User.prototype, {
        ...Object.getOwnPropertyDescriptors(baseUser),
        // Make sure the user correctly identifies as a User
        constructor: { value: User },
    });

    return mockUser;
}

/**
 * Creates a mock Discord.js ClientUser that correctly passes instanceof checks
 */
export function createMockClientUser(overrides: Partial<ClientUser> = {}): ClientUser {
    // Create base object, extending User properties
    const baseClientUser = {
        ...createMockUser(), // Start with base user properties, then override
        id: '987654321098765432', // Bot's user ID
        username: 'TestBot',
        tag: 'TestBot#0000',
        discriminator: '0000', // Ensure discriminator is consistent with tag
        bot: true, // ClientUser is always a bot
        mfaEnabled: false,
        verified: true,
        presence: { // Mock ClientPresence
            status: 'online',
            activities: [],
            clientStatus: null, // Platform statuses (desktop, mobile, web)
            set: vi.fn().mockReturnThis(), // Mock method for setting presence
            patch: vi.fn().mockReturnThis(), // Mock method for patching presence
            equals: vi.fn().mockReturnValue(false), // From Presence base class
        },
        edit: vi.fn().mockImplementation(function () { // Mock method for editing user profile
            return Promise.resolve(this);
        }),
        // Other ClientUser specific properties or methods as needed
        // displayAvatarURL, send, fetch, toString, etc., are inherited from createMockUser()
    };

    // Add overrides provided by the caller
    Object.assign(baseClientUser, overrides);

    // Create a properly structured mock that will pass instanceof checks
    const mockClientUser = Object.create(ClientUser.prototype, {
        ...Object.getOwnPropertyDescriptors(baseClientUser),
        constructor: { value: ClientUser }, // Ensure correct constructor for instanceof
    });

    return mockClientUser;
}

/**
 * Creates a mock Discord.js CommandInteraction
 */
export function createMockCommandInteraction(
    overrides: Partial<CommandInteraction> = {}
): Partial<CommandInteraction> {
    // Create a mock guild member first to ensure consistent user data
    const mockMember = createMockGuildMember();

    return {
        id: '987612345678901234',
        user: mockMember.user,
        member: mockMember,
        client: {
            user: createMockClientUser(), // Use the new helper
        } as Client<true>, // Cast client to Client<true> which has a non-null user
        guild: mockMember.guild,
        channel: createMockTextChannel(), // Use the new helper for a TextChannel
        commandName: 'test',
        options: Object.assign(Object.create(CommandInteractionOptionResolver.prototype), {
            constructor: { value: CommandInteractionOptionResolver },
            // Mocked methods that are commonly used
            getString: vi.fn().mockReturnValue(null),
            getUser: vi.fn().mockReturnValue(null),
            getInteger: vi.fn().mockReturnValue(null),
            getBoolean: vi.fn().mockReturnValue(null),
            getSubcommand: vi.fn().mockReturnValue(null),
            getSubcommandGroup: vi.fn().mockReturnValue(null),
            getMember: vi.fn().mockReturnValue(null),
            getChannel: vi.fn().mockReturnValue(null),
            getRole: vi.fn().mockReturnValue(null),
            getNumber: vi.fn().mockReturnValue(null),
            getMentionable: vi.fn().mockReturnValue(null),
            getAttachment: vi.fn().mockReturnValue(null),
            // Mock internal-like properties often part of the structure
            _group: null,
            _subcommand: null,
            _hoistedOptions: [],
            // Ensure client is available on options resolver, if needed by its methods
            // client: this.client, // This would require 'this' context or passing client
        }),
        reply: vi.fn().mockResolvedValue({}),
        editReply: vi.fn().mockResolvedValue({}),
        deferReply: vi.fn().mockResolvedValue({}),
        followUp: vi.fn().mockResolvedValue({}),
        deferred: false,
        replied: false,
        ...overrides,
    };
}

/**
 * Creates a mock Discord.js GuildChannel that correctly passes instanceof checks
 */
export function createMockGuildChannel(overrides: Partial<GuildChannel> = {}): GuildChannel {
    // Create base object with properties we need
    const baseChannel = {
        id: '444555666777888999',
        name: 'test-channel',
        guild: { id: '111222333444555666', name: 'Test Guild' },
        client: {
            user: createMockClientUser(),
        } as Client<true>,
        type: ChannelType.GuildText,
    };

    // Add overrides
    Object.assign(baseChannel, overrides);

    // Create a properly structured mock that will pass instanceof checks
    const mockChannel = Object.create(GuildChannel.prototype, {
        ...Object.getOwnPropertyDescriptors(baseChannel),
        // Make sure the channel correctly identifies as a GuildChannel
        constructor: { value: GuildChannel },
    });

    return mockChannel;
}

/**
 * Creates a mock Discord.js TextChannel that correctly passes instanceof checks
 */
export function createMockTextChannel(overrides: Partial<TextChannel> = {}): TextChannel {
    // Create base object with properties we need for a TextChannel
    const baseChannel = {
        id: '555666777888999000',
        name: 'general',
        guild: { id: '111222333444555666', name: 'Test Guild' }, // Mock guild
        client: { // Mock client
            user: createMockClientUser(), // Use the helper for consistency
        } as Client<true>,
        type: ChannelType.GuildText, // Correct channel type
        // TextBasedChannel properties and methods
        send: vi.fn().mockResolvedValue({}), // Mock send method
        bulkDelete: vi.fn().mockResolvedValue([]), // Mock bulkDelete method
        isTextBased: vi.fn().mockReturnValue(true), // Ensure it's identified as text-based
        // Other TextChannel specific properties or methods
        topic: null,
        nsfw: false,
        lastMessageId: null,
        lastPinTimestamp: null,
        rateLimitPerUser: 0,
        permissionsFor: vi.fn().mockReturnValue({ // Mock permissionsFor method
            has: vi.fn().mockReturnValue(true), // Default to having permissions
        }),
        // Methods from GuildChannel (if not on TextChannel.prototype directly)
        // Methods from Channel (if not on TextChannel.prototype directly)
        fetch: vi.fn().mockImplementation(function () { return Promise.resolve(this); }),
        toString: vi.fn().mockReturnValue('<#555666777888999000>'),
    };

    // Add overrides provided by the caller
    Object.assign(baseChannel, overrides);

    // Create a properly structured mock that will pass instanceof checks
    const mockChannel = Object.create(TextChannel.prototype, {
        ...Object.getOwnPropertyDescriptors(baseChannel),
        constructor: { value: TextChannel }, // Ensure correct constructor for instanceof
    });

    return mockChannel;
}

/**
 * Creates a mock Discord.js ThreadChannel that correctly passes instanceof checks
 */
export function createMockThreadChannel(overrides: Partial<ThreadChannel> = {}): ThreadChannel {
    // Create base object with properties we need
    const baseChannel = {
        id: '444555666777888999',
        name: 'test-thread',
        guild: { id: '111222333444555666', name: 'Test Guild' },
        client: {
            user: createMockClientUser(),
        } as Client<true>,
        type: ChannelType.PublicThread,
        permissionsFor: vi.fn().mockReturnValue({
            has: vi.fn().mockReturnValue(true),
        }),
    };

    // Add overrides
    Object.assign(baseChannel, overrides);

    // Create a properly structured mock that will pass instanceof checks
    const mockChannel = Object.create(ThreadChannel.prototype, {
        ...Object.getOwnPropertyDescriptors(baseChannel),
        // Make sure the channel correctly identifies as a ThreadChannel
        constructor: { value: ThreadChannel },
    });

    return mockChannel;
}

/**
 * Creates a mock Command object
 */
export function createMockCommand(overrides: Record<string, any> = {}): any {
    return {
        names: ['test'],
        deferType: 'HIDDEN',
        requireClientPerms: [],
        execute: vi.fn().mockResolvedValue({}),
        cooldown: {
            take: vi.fn().mockReturnValue(false),
            amount: 1,
            interval: 5000,
        },
        ...overrides,
    };
}

/**
 * Creates a mock Discord.js GuildMember that correctly passes instanceof checks
 */
export function createMockGuildMember(overrides: Partial<GuildMember> = {}): GuildMember {
    // Create a mock user first
    const mockUser = createMockUser();

    // Create base object with properties we need
    const baseMember = {
        id: mockUser.id,
        user: mockUser,
        guild: { id: '111222333444555666', name: 'Test Guild' },
        displayName: mockUser.username,
        nickname: null,
        roles: {
            cache: new Map(),
            highest: { position: 1, id: '222333444555666777' },
            add: vi.fn().mockResolvedValue({}),
            remove: vi.fn().mockResolvedValue({}),
        },
        permissions: new PermissionsBitField(PermissionFlagsBits.SendMessages),
        permissionsIn: vi
            .fn()
            .mockReturnValue(new PermissionsBitField(PermissionFlagsBits.SendMessages)),
        joinedAt: new Date(),
        voice: {
            channelId: null,
            channel: null,
            mute: false,
            deaf: false,
        },
        presence: {
            status: 'online',
            activities: [],
        },
        manageable: true,
        kickable: true,
        bannable: true,
        moderatable: true,
        communicationDisabledUntil: null,
        // Common methods
        kick: vi.fn().mockResolvedValue({}),
        ban: vi.fn().mockResolvedValue({}),
        timeout: vi.fn().mockResolvedValue({}),
        edit: vi.fn().mockResolvedValue({}),
        fetch: vi.fn().mockImplementation(function () {
            return Promise.resolve(this);
        }),
        send: vi.fn().mockResolvedValue({}),
    };

    // Add overrides
    Object.assign(baseMember, overrides);

    // Create a properly structured mock that will pass instanceof checks
    const mockMember = Object.create(GuildMember.prototype, {
        ...Object.getOwnPropertyDescriptors(baseMember),
        // Make sure the member correctly identifies as a GuildMember
        constructor: { value: GuildMember },
    });

    return mockMember;
}
