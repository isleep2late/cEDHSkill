/// <reference types="vitest/globals" />

vi.mock('../../../src/utils/rating-utils.js', () => ({
    RatingUtils: {
        calculateElo: vi.fn((mu, sigma) => Math.round((mu - 3 * sigma + 20) * 58.33)), // Basic mock
        calculateOrdinal: vi.fn((mu, sigma) => mu - 3 * sigma), // Basic mock
    },
}));
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import { ChatInputCommandInteraction, EmbedBuilder, Locale, CacheType, User, Collection } from 'discord.js';

import { ListCommand } from '../../../src/commands/chat/list-command.js';
import type { PlayerRatingModelStatic, PlayerRatingInstance } from '../../../src/models/db/player-rating.js';
import { PlayerRating } from '../../../src/db.js';
import { RatingUtils } from '../../../src/utils/rating-utils.js';
import { EventData } from '../../../src/models/internal-models.js';
import { DiscordLimits } from '../../../src/constants/index.js';

// --- Mocking Section ---

vi.mock('../../../src/db.js', () => ({
    PlayerRating: {
        findAll: vi.fn(),
    },
}));

vi.mock('../../../src/services/lang.js', () => {
    const mockLangGetRef = vi.fn();
    const mockLangGetEmbed = vi.fn();
    return {
        Lang: {
            getRef: mockLangGetRef,
            getEmbed: mockLangGetEmbed,
            getComRef: vi.fn((key: string) => key),
            getCom: vi.fn().mockReturnValue('{{COM_MOCK}}'),
            getRefLocalizationMap: vi.fn(() => ({})),
        },
    };
});

vi.mock('../../../src/utils/interaction-utils.js', () => ({
    InteractionUtils: {
        send: vi.fn(),
    },
}));

vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');
    const MockedEmbedBuilder = vi.fn(() => ({
        setTitle: vi.fn().mockReturnThis(),
        setDescription: vi.fn().mockReturnThis(),
        addFields: vi.fn().mockReturnThis(),
        setColor: vi.fn().mockReturnThis(),
        setFooter: vi.fn().mockReturnThis(),
        data: {}, // Add data property for footer access
    }));
    return {
        ...actual,
        EmbedBuilder: MockedEmbedBuilder,
        Locale: actual.Locale,
        Collection: actual.Collection,
    };
});

// --- Test Suite ---

describe('ListCommand', () => {
    let listCommand: ListCommand;
    let mockIntr: ChatInputCommandInteraction<CacheType>;
    let mockEventData: EventData;
    const MOCK_GUILD_ID = 'testGuildId123';
    const MOCK_GUILD_NAME = 'Test Server';

    let langGetRefMock: MockedFunction<any>;
    let langGetEmbedMock: MockedFunction<any>;
    let interactionUtilsSendMock: MockedFunction<any>;
    let mockPlayerRatingFindAllFn: MockedFunction<typeof PlayerRating.findAll>;
    let mockClientUsersFetch: MockedFunction<(id: string) => Promise<User | null>>;
    let currentMockEmbed: EmbedBuilder;


    beforeEach(async () => {
        listCommand = new ListCommand();

        const { PlayerRating: MockedPlayerRating } = await import('../../../src/db.js');
        mockPlayerRatingFindAllFn = MockedPlayerRating.findAll as MockedFunction<typeof PlayerRating.findAll>;

        const { Lang } = await import('../../../src/services/lang.js');
        langGetRefMock = Lang.getRef as MockedFunction<any>;
        langGetEmbedMock = Lang.getEmbed as MockedFunction<any>;

        const { InteractionUtils } = await import('../../../src/utils/interaction-utils.js');
        interactionUtilsSendMock = InteractionUtils.send as MockedFunction<any>;

        currentMockEmbed = new EmbedBuilder();
        langGetEmbedMock.mockReturnValue(currentMockEmbed);
        (currentMockEmbed as any).data = { footer: null }; // Initialize footer for testing

        mockClientUsersFetch = vi.fn();

        mockEventData = new EventData(Locale.EnglishUS, Locale.EnglishUS);

        mockIntr = {
            options: {
                getInteger: vi.fn().mockReturnValue(null), // Default to null (N not specified)
                getString: vi.fn(),
                getUser: vi.fn(),
            },
            user: { id: 'intrUserId' } as User,
            guild: {
                id: MOCK_GUILD_ID,
                name: MOCK_GUILD_NAME,
            },
            client: {
                users: {
                    fetch: mockClientUsersFetch,
                    cache: new Collection<string, User>(), // Mock cache
                },
            },
            reply: vi.fn(),
            deferReply: vi.fn(),
            editReply: vi.fn(),
            followUp: vi.fn(),
            channelId: 'mockChannelId',
            commandName: 'list',
            isCommand: () => true,
            isChatInputCommand: () => true,
        } as unknown as ChatInputCommandInteraction<CacheType>;

        langGetRefMock.mockImplementation((keyInput: unknown, _langInput?: unknown, varsInput?: unknown): string => {
            const key = keyInput as string;
            const vars = varsInput as { SHOWN_COUNT?: string | number; REQUESTED_COUNT?: string | number } | undefined;
            if (key === 'arguments.count') return 'count';
            if (key === 'displayEmbeds.listFooterTruncated' && vars && vars.SHOWN_COUNT !== undefined && vars.REQUESTED_COUNT !== undefined) {
                return `Showing top ${vars.SHOWN_COUNT} of ${vars.REQUESTED_COUNT} requested players.`;
            }
            return key || '';
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should list top 10 players by default including W/L when N is not specified', async () => {
        const mockPlayers = Array.from({ length: 15 }, (_, i) => ({
            userId: `user${i + 1}`,
            guildId: MOCK_GUILD_ID,
            mu: 50 - i,
            sigma: 5,
            wins: i + 1,
            losses: i,
            user: { tag: `UserTag${i+1}#0000` }
        }));
        const mockPlayersWithElo = mockPlayers.slice(0, 10).map(p => ({
            ...p,
            elo: RatingUtils.calculateElo(p.mu, p.sigma),
        })) as unknown as PlayerRatingInstance[];

        mockPlayerRatingFindAllFn.mockResolvedValue(mockPlayersWithElo as any);
        mockClientUsersFetch.mockImplementation(async (id: string) => ({ id, tag: `${id}Tag` } as User));


        await listCommand.execute(mockIntr, mockEventData);

        expect(mockIntr.options.getInteger).toHaveBeenCalledWith('count');
        expect(mockPlayerRatingFindAllFn).toHaveBeenCalledWith({
            where: { guildId: MOCK_GUILD_ID },
            order: [['mu', 'DESC']],
            limit: 10,
        });
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.listPlayersTitle',
            mockEventData.lang,
            { GUILD_NAME: MOCK_GUILD_NAME }
        );
        expect(currentMockEmbed.addFields).toHaveBeenCalledTimes(10);
        // Example check for one player's W/L display
        const firstPlayer = mockPlayersWithElo[0];
        const expectedElo = RatingUtils.calculateElo(firstPlayer.mu, firstPlayer.sigma);
        expect(currentMockEmbed.addFields).toHaveBeenCalledWith(
            expect.objectContaining({
                value: `Elo: ${expectedElo}, μ: ${firstPlayer.mu.toFixed(2)}, σ: ${firstPlayer.sigma.toFixed(2)}, W/L: ${firstPlayer.wins}/${firstPlayer.losses}`,
            })
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });

    it('should list top N players when N is specified and valid, including W/L', async () => {
        (mockIntr.options.getInteger as MockedFunction<any>).mockReturnValue(5);
        const mockPlayers = Array.from({ length: 5 }, (_, i) => ({
            userId: `user${i + 1}`,
            guildId: MOCK_GUILD_ID,
            mu: 50 - i,
            sigma: 5,
            wins: i,
            losses: 5 - i,
        })) as unknown as PlayerRatingInstance[];
        mockPlayerRatingFindAllFn.mockResolvedValue(mockPlayers as any);
        mockClientUsersFetch.mockImplementation(async (id: string) => ({ id, tag: `${id}Tag` } as User));


        await listCommand.execute(mockIntr, mockEventData);

        expect(mockPlayerRatingFindAllFn).toHaveBeenCalledWith({
            where: { guildId: MOCK_GUILD_ID },
            order: [['mu', 'DESC']],
            limit: 5,
        });
        expect(currentMockEmbed.addFields).toHaveBeenCalledTimes(5);
        const firstListedPlayer = mockPlayers[0];
        expect(currentMockEmbed.addFields).toHaveBeenCalledWith(
             expect.objectContaining({
                value: `Elo: ${RatingUtils.calculateElo(firstListedPlayer.mu, firstListedPlayer.sigma)}, μ: ${firstListedPlayer.mu.toFixed(2)}, σ: ${firstListedPlayer.sigma.toFixed(2)}, W/L: ${firstListedPlayer.wins}/${firstListedPlayer.losses}`,
            })
        );
    });

    it('should send "guild only" error if command is used outside a guild', async () => {
        const intrNoGuild = {
            ...mockIntr,
            guild: null,
        } as unknown as ChatInputCommandInteraction<CacheType>;

        await listCommand.execute(intrNoGuild, mockEventData);

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'errorEmbeds.guildOnlyCommand',
            mockEventData.lang
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(intrNoGuild, currentMockEmbed, true);
    });

    it('should send "invalid count" error if N is zero or negative', async () => {
        (mockIntr.options.getInteger as MockedFunction<any>).mockReturnValue(0);

        await listCommand.execute(mockIntr, mockEventData);

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'validationEmbeds.listCountInvalid',
            mockEventData.lang
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
    });

    it('should send "no players" embed if no players are found in the guild', async () => {
        mockPlayerRatingFindAllFn.mockResolvedValue([]);

        await listCommand.execute(mockIntr, mockEventData);

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.listNoPlayers',
            mockEventData.lang,
            { GUILD_NAME: MOCK_GUILD_NAME }
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });

    it('should limit N to Discord embed field limit and add a truncated footer', async () => {
        const requestedCount = DiscordLimits.FIELDS_PER_EMBED + 5;
        (mockIntr.options.getInteger as MockedFunction<any>).mockReturnValue(requestedCount);

        const mockPlayers = Array.from({ length: DiscordLimits.FIELDS_PER_EMBED }, (_, i) => ({
            userId: `user${i + 1}`,
            guildId: MOCK_GUILD_ID,
            mu: 100 - i,
            sigma: 5,
            wins: i,
            losses: i
        })) as unknown as PlayerRatingInstance[];
        mockPlayerRatingFindAllFn.mockResolvedValue(mockPlayers as any);
        mockClientUsersFetch.mockImplementation(async (id: string) => ({ id, tag: `${id}Tag` } as User));


        await listCommand.execute(mockIntr, mockEventData);

        expect(mockPlayerRatingFindAllFn).toHaveBeenCalledWith(
            expect.objectContaining({ limit: DiscordLimits.FIELDS_PER_EMBED })
        );
        expect(currentMockEmbed.addFields).toHaveBeenCalledTimes(DiscordLimits.FIELDS_PER_EMBED);
        expect(currentMockEmbed.setFooter).toHaveBeenCalledWith({
            text: `Showing top ${DiscordLimits.FIELDS_PER_EMBED} of ${requestedCount} requested players.`
        });
    });


    it('should correctly display player tags, defaulting to userID if user fetch fails, and show W/L', async () => {
        const mockPlayers = [
            { userId: 'fetchedUser', guildId: MOCK_GUILD_ID, mu: 50, sigma: 5, wins: 3, losses: 1 },
            { userId: 'unfetchedUser', guildId: MOCK_GUILD_ID, mu: 48, sigma: 6, wins: 0, losses: 2 },
        ] as PlayerRatingInstance[];
        mockPlayerRatingFindAllFn.mockResolvedValue(mockPlayers as any);

        mockClientUsersFetch.mockImplementation(async (id: string) => {
            if (id === 'fetchedUser') return { id, tag: 'FetchedUserTag#1234' } as User;
            throw new Error('User not found'); // Simulate fetch failure for 'unfetchedUser'
        });

        await listCommand.execute(mockIntr, mockEventData);

        expect(currentMockEmbed.addFields).toHaveBeenCalledWith({
            name: '1. FetchedUserTag#1234',
            value: `Elo: ${RatingUtils.calculateElo(50, 5)}, μ: 50.00, σ: 5.00, W/L: 3/1`,
            inline: false,
        });
        expect(currentMockEmbed.addFields).toHaveBeenCalledWith({
            name: '2. unfetchedUser', // Fallback to ID
            value: `Elo: ${RatingUtils.calculateElo(48, 6)}, μ: 48.00, σ: 6.00, W/L: 0/2`,
            inline: false,
        });
    });

    it('should display wins/losses as 0 if they are null or undefined in the database record', async () => {
        const mockPlayers = [
            { userId: 'player1', guildId: MOCK_GUILD_ID, mu: 50, sigma: 5, wins: null, losses: 2 },
            { userId: 'player2', guildId: MOCK_GUILD_ID, mu: 48, sigma: 6, wins: 3, losses: undefined },
            { userId: 'player3', guildId: MOCK_GUILD_ID, mu: 45, sigma: 7, wins: null, losses: null },
        ] as unknown as PlayerRatingInstance[];
        mockPlayerRatingFindAllFn.mockResolvedValue(mockPlayers as any);
        mockClientUsersFetch.mockImplementation(async (id: string) => ({ id, tag: `${id}Tag` } as User));

        await listCommand.execute(mockIntr, mockEventData);

        expect(currentMockEmbed.addFields).toHaveBeenCalledWith(
            expect.objectContaining({
                name: expect.stringContaining('player1Tag'),
                value: expect.stringContaining('W/L: 0/2'),
            })
        );
         expect(currentMockEmbed.addFields).toHaveBeenCalledWith(
            expect.objectContaining({
                name: expect.stringContaining('player2Tag'),
                value: expect.stringContaining('W/L: 3/0'),
            })
        );
        expect(currentMockEmbed.addFields).toHaveBeenCalledWith(
            expect.objectContaining({
                name: expect.stringContaining('player3Tag'),
                value: expect.stringContaining('W/L: 0/0'),
            })
        );
    });

    it('should not add truncated footer if player count is less than embed limit, even if requested N was higher', async () => {
        const requestedCount = DiscordLimits.FIELDS_PER_EMBED + 5;
        (mockIntr.options.getInteger as MockedFunction<any>).mockReturnValue(requestedCount);

        const mockPlayers = Array.from({ length: 5 }, (_, i) => ({
            userId: `user${i + 1}`, guildId: MOCK_GUILD_ID, mu: 100 - i, sigma: 5, wins: i, losses: 1
        })) as unknown as PlayerRatingInstance[];
        mockPlayerRatingFindAllFn.mockResolvedValue(mockPlayers as any);
        mockClientUsersFetch.mockImplementation(async (id: string) => ({ id, tag: `${id}Tag` } as User));

        await listCommand.execute(mockIntr, mockEventData);
        expect(currentMockEmbed.addFields).toHaveBeenCalledTimes(5);
        expect(currentMockEmbed.setFooter).not.toHaveBeenCalled();
    });
});