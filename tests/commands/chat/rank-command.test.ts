/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import { ChatInputCommandInteraction, EmbedBuilder, Locale, CacheType, User } from 'discord.js';
import { rating, rate, Rating as OpenSkillRating } from 'openskill';

import { RankCommand } from '../../../src/commands/chat/rank-command.js';
import type { PlayerRatingModelStatic, PlayerRatingInstance } from '../../../src/models/db/player-rating.js';
import { PlayerRating } from '../../../src/db.js';
import { EventData } from '../../../src/models/internal-models.js';

// --- Mocking Section ---

// Mock for openskill
vi.mock('openskill', () => ({
    rating: vi.fn(),
    rate: vi.fn(),
}));

// Mock for db.js
vi.mock('../../../src/db.js', () => ({
    PlayerRating: {
        findOne: vi.fn(),
        upsert: vi.fn(),
    },
    initializeDatabase: vi.fn().mockResolvedValue(undefined),
    sequelize: {},
}));

// Mock for services/lang.js
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

// Mock for utils/rating-utils.ts - though for command tests, we might let it run if it's just pure functions
// For now, assume we might want to spy or ensure it's called, or provide specific values if complex.
// However, since calculateElo is straightforward, we'll likely test its output via the command.
// vi.mock('../../../src/utils/rating-utils.js', () => ({
// RatingUtils: {
// calculateElo: vi.fn(),
// calculateOrdinal: vi.fn(),
// },
// }));

// Mock for utils/interaction-utils.js
vi.mock('../../../src/utils/interaction-utils.js', () => ({
    InteractionUtils: {
        send: vi.fn(),
    },
}));

// Mock for discord.js (specifically EmbedBuilder and User related mocks if needed)
vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');
    const MockedEmbedBuilder = vi.fn(() => ({
        setTitle: vi.fn().mockReturnThis(),
        addFields: vi.fn().mockReturnThis(),
        setDescription: vi.fn().mockReturnThis(),
        setColor: vi.fn().mockReturnThis(),
        setThumbnail: vi.fn().mockReturnThis(),
        setAuthor: vi.fn().mockReturnThis(),
        setFooter: vi.fn().mockReturnThis(),
        setTimestamp: vi.fn().mockReturnThis(),
    }));
    return {
        ...actual,
        EmbedBuilder: MockedEmbedBuilder,
        Locale: actual.Locale,
    };
});

// --- Test Suite ---

describe('RankCommand', () => {
    let rankCommand: RankCommand;
    let mockIntr: ChatInputCommandInteraction<CacheType>;
    let mockEventData: EventData;
    const MOCK_GUILD_ID = 'testGuildId';

    let langGetRefMock: MockedFunction<any>;
    let langGetEmbedMock: MockedFunction<any>;
    let interactionUtilsSendMock: MockedFunction<any>;
    let ratingMock: MockedFunction<any>;
    let rateMock: MockedFunction<any>;
    let mockClientUsersFetch: MockedFunction<(id: string) => Promise<User | null>>;
    let currentMockEmbed: EmbedBuilder;
    let mockPlayerRatingFindOneFn: MockedFunction<typeof PlayerRating.findOne>;
    let mockPlayerRatingUpsertFn: MockedFunction<typeof PlayerRating.upsert>;


    beforeEach(async () => {
        rankCommand = new RankCommand();

        // Dynamically import mocked modules to get their mock functions
        const { PlayerRating: MockedPlayerRating } = await import('../../../src/db.js');
        mockPlayerRatingFindOneFn = MockedPlayerRating.findOne as MockedFunction<typeof PlayerRating.findOne>;
        mockPlayerRatingUpsertFn = MockedPlayerRating.upsert as MockedFunction<typeof PlayerRating.upsert>;

        const { Lang } = await import('../../../src/services/lang.js');
        langGetRefMock = Lang.getRef as MockedFunction<any>;
        langGetEmbedMock = Lang.getEmbed as MockedFunction<any>;

        const { InteractionUtils } = await import('../../../src/utils/interaction-utils.js');
        interactionUtilsSendMock = InteractionUtils.send as MockedFunction<any>;

        const { rating, rate } = await import('openskill');
        ratingMock = rating as MockedFunction<any>;
        rateMock = rate as MockedFunction<any>;

        currentMockEmbed = new EmbedBuilder(); // This will use the mocked EmbedBuilder
        langGetEmbedMock.mockReturnValue(currentMockEmbed);

        // Clear mocks
        langGetRefMock.mockClear();
        langGetEmbedMock.mockClear();
        interactionUtilsSendMock.mockClear();

        // Setup default mock for langGetRef to avoid undefined issues
        langGetRefMock.mockImplementation((keyInput: unknown, _langInput?: unknown, varsInput?: unknown): string => {
            const key = keyInput as string;
            // Assuming Lang.getRef vars is Record<string, string | number>
            const vars = varsInput as Record<string, string | number> | undefined; 
            if (key === 'fields.updatedRatings') {
                return 'Updated Ratings'; // Default mock value
            }
            if (key === 'arguments.results') {
                return 'results'; // Default mock value
            }
            return key || ''; // Fallback, ensure string return
        });
        mockPlayerRatingFindOneFn.mockReset();
        mockPlayerRatingUpsertFn.mockReset();
        ratingMock.mockClear();
        rateMock.mockClear();


        mockEventData = {
            lang: Locale.EnglishUS,
            langGuild: Locale.EnglishUS,
        } as EventData;

        mockClientUsersFetch = vi.fn(async (id: string): Promise<User | null> => {
            if (id === '123') return { id: '123', username: 'User123' } as User;
            if (id === '456') return { id: '456', username: 'User456' } as User;
            if (id === '789') return { id: '789', username: 'User789' } as User;
            if (id === '101') return { id: '101', username: 'User101' } as User;
            return null;
        });

        mockIntr = {
            options: {
                getString: vi.fn(),
                getNumber: vi.fn(),
                getBoolean: vi.fn(),
                getUser: vi.fn(),
                getMember: vi.fn(),
                getChannel: vi.fn(),
                getRole: vi.fn(),
                getMentionable: vi.fn(),
                getAttachment: vi.fn(),
                getSubcommand: vi.fn().mockReturnValue(null),
                getSubcommandGroup: vi.fn().mockReturnValue(null),
            },
            user: { id: 'testUser' } as User,
            guild: { id: MOCK_GUILD_ID, name: 'Test Guild' },
            client: {
                user: { id: 'botId' } as User,
                users: { fetch: mockClientUsersFetch }
            },
            reply: vi.fn().mockResolvedValue({}),
            editReply: vi.fn().mockResolvedValue({}),
            deferReply: vi.fn().mockResolvedValue({}),
            followUp: vi.fn().mockResolvedValue({}),
            deferred: false,
            replied: false,
            channelId: 'mockChannelId',
            commandName: 'rank',
            isCommand: () => true,
            isChatInputCommand: () => true,
        } as unknown as ChatInputCommandInteraction<CacheType>;

        ratingMock.mockImplementation((rInput?: unknown): OpenSkillRating => {
            const r = rInput as { mu: number; sigma: number } | undefined;
            return {
                mu: r?.mu ?? 25,
                sigma: r?.sigma ?? (25 / 3),
            };
        });
    });

    afterEach(() => {
        vi.restoreAllMocks(); // Restore original implementations
    });

    it('should correctly parse input, update ratings for 1v1 in a guild, and send success embed', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> l');

        mockPlayerRatingFindOneFn
            .mockResolvedValueOnce(null as any) // For player 123 (new player)
            .mockResolvedValueOnce({ userId: '456', guildId: MOCK_GUILD_ID, mu: 20, sigma: 5 } as unknown as PlayerRatingInstance); // For player 456 (existing)

        const mockInitialRatingP1: OpenSkillRating = { mu: 25, sigma: 25 / 3 }; // Default for new player
        const mockInitialRatingP2FromDB: OpenSkillRating = { mu: 20, sigma: 5 }; // From DB for existing player
        ratingMock.mockImplementation((configInput?: unknown): OpenSkillRating => {
            const config = configInput as { mu: number; sigma: number } | undefined;
            if (config && config.mu === 20 && config.sigma === 5) {
                return mockInitialRatingP2FromDB;
            }
            return mockInitialRatingP1; // Default or new player
        });


        const mockNewRatingP1: OpenSkillRating = { mu: 28, sigma: 7 };
        const mockNewRatingP2: OpenSkillRating = { mu: 18, sigma: 4.8 };
        rateMock.mockReturnValue([
            [mockNewRatingP1], // Winner(s) new ratings
            [mockNewRatingP2], // Loser(s) new ratings
        ]);

        await rankCommand.execute(mockIntr, mockEventData);

        expect(langGetRefMock).toHaveBeenCalledWith('arguments.results', mockEventData.lang);
        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledWith({ where: { userId: '123', guildId: MOCK_GUILD_ID } });
        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledWith({ where: { userId: '456', guildId: MOCK_GUILD_ID } });

        expect(rateMock).toHaveBeenCalledWith([
            [mockInitialRatingP1], // Player 123's initial rating (winner)
            [mockInitialRatingP2FromDB], // Player 456's initial rating (loser)
        ]);

        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({ userId: '123', guildId: MOCK_GUILD_ID, mu: 28, sigma: 7 });
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({ userId: '456', guildId: MOCK_GUILD_ID, mu: 18, sigma: 4.8 });

        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
        expect(interactionUtilsSendMock).toHaveBeenCalled();
        const sentEmbed = (interactionUtilsSendMock as MockedFunction<any>).mock.calls[0][1] as EmbedBuilder;
        expect(langGetEmbedMock).toHaveBeenCalledWith('displayEmbeds.rankSuccess', mockEventData.lang);
        expect(sentEmbed.setTitle).toHaveBeenCalledWith('Updated Ratings');
        expect(sentEmbed.addFields).toHaveBeenCalledTimes(2);
        // Verify winner's field
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: '<@User123> (Winner)',
            value: 'Old: Elo=1167, μ=25.00, σ=8.33\nNew: Elo=1575, μ=28.00, σ=7.00',
            inline: false,
        });
        // Verify loser's field
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: '<@User456> (Loser)',
            value: 'Old: Elo=1458, μ=20.00, σ=5.00\nNew: Elo=1377, μ=18.00, σ=4.80',
            inline: false,
        });
    });

    it('should send "guild only" error if command is used outside a guild', async () => {
        const intrNoGuild = {
            ...mockIntr,
            guild: null,
        } as unknown as ChatInputCommandInteraction<CacheType>;
        (intrNoGuild.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> l');


        await rankCommand.execute(intrNoGuild, mockEventData);

        expect(interactionUtilsSendMock).toHaveBeenCalledWith(intrNoGuild, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith('errorEmbeds.commandNotInGuild', mockEventData.lang);
        expect(mockPlayerRatingFindOneFn).not.toHaveBeenCalled();
        expect(rateMock).not.toHaveBeenCalled();
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();
    });


    it('should send "not enough players" error for single player input', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w');
        await rankCommand.execute(mockIntr, mockEventData);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith('validationEmbeds.rankNotEnoughPlayers', mockEventData.lang);
        expect(mockPlayerRatingFindOneFn).not.toHaveBeenCalled();
        expect(rateMock).not.toHaveBeenCalled();
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();
    });

    it('should send "parsing error" if no players are parsed but input is not empty', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('this is not a valid result string');
        await rankCommand.execute(mockIntr, mockEventData);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith('validationEmbeds.rankErrorParsing', mockEventData.lang);
        expect(mockPlayerRatingFindOneFn).not.toHaveBeenCalled();
        expect(rateMock).not.toHaveBeenCalled();
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();
    });

    it('should send "invalid outcome" if only winners are provided', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> w');

        mockPlayerRatingFindOneFn.mockResolvedValue({ userId: 'someId', guildId: MOCK_GUILD_ID, mu: 25, sigma: 25/3 } as unknown as PlayerRatingInstance);
        await rankCommand.execute(mockIntr, mockEventData);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith('validationEmbeds.rankInvalidOutcome', mockEventData.lang);
        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledTimes(2);
        expect(rateMock).not.toHaveBeenCalled();
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();
    });

    it('should send "invalid outcome" if only losers are provided', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> l <@456> l');
        mockPlayerRatingFindOneFn.mockResolvedValue({ userId: 'someId', guildId: MOCK_GUILD_ID, mu: 25, sigma: 25/3 } as unknown as PlayerRatingInstance);

        await rankCommand.execute(mockIntr, mockEventData);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith('validationEmbeds.rankInvalidOutcome', mockEventData.lang);
        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledTimes(2);
        expect(rateMock).not.toHaveBeenCalled();
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();
    });

    it('should correctly parse multiple winners and losers in a guild', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue(
            '<@123> w <@456> w <@789> l <@101> l'
        );

        mockPlayerRatingFindOneFn
            .mockResolvedValueOnce(null as any)
            .mockResolvedValueOnce({ userId: '456', guildId: MOCK_GUILD_ID, mu: 22, sigma: 6 } as unknown as PlayerRatingInstance)
            .mockResolvedValueOnce({ userId: '789', guildId: MOCK_GUILD_ID, mu: 28, sigma: 4 } as unknown as PlayerRatingInstance)
            .mockResolvedValueOnce(null as any);

        const initialRatings: { [key: string]: OpenSkillRating } = {
            p1: { mu: 25, sigma: 25 / 3 },
            p2: { mu: 22, sigma: 6 },
            p3: { mu: 28, sigma: 4 },
            p4: { mu: 25, sigma: 25 / 3 },
        };
        ratingMock.mockImplementation((configInput?: unknown): OpenSkillRating => {
            const config = configInput as { mu: number; sigma: number } | undefined;
            if (!config) return { mu: 25, sigma: 25 / 3 }; // Default for new players
            if (config.mu === 22 && config.sigma === 6) return initialRatings.p2;
            if (config.mu === 28 && config.sigma === 4) return initialRatings.p3;
            return { mu: 25, sigma: 25 / 3 }; // Default for other new players
        });

        const updatedRatingsMock: OpenSkillRating[] = [
            { mu: 27, sigma: 7 },
            { mu: 24, sigma: 5.8 },
            { mu: 26, sigma: 3.9 },
            { mu: 23, sigma: 7 },
        ];

        rateMock.mockReturnValue([
            [updatedRatingsMock[0], updatedRatingsMock[1]], // Winners' new ratings
            [updatedRatingsMock[2], updatedRatingsMock[3]], // Losers' new ratings
        ]);

        await rankCommand.execute(mockIntr, mockEventData);

        expect(rateMock).toHaveBeenCalledWith([
            [initialRatings.p1, initialRatings.p2], // Winners' initial ratings
            [initialRatings.p3, initialRatings.p4], // Losers' initial ratings
        ]);

        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({ userId: '123', guildId: MOCK_GUILD_ID, ...updatedRatingsMock[0] });
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({ userId: '456', guildId: MOCK_GUILD_ID, ...updatedRatingsMock[1] });
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({ userId: '789', guildId: MOCK_GUILD_ID, ...updatedRatingsMock[2] });
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({ userId: '101', guildId: MOCK_GUILD_ID, ...updatedRatingsMock[3] });

        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
        const sentEmbed = (interactionUtilsSendMock as MockedFunction<any>).mock.calls[0][1] as EmbedBuilder;
        expect(langGetEmbedMock).toHaveBeenCalledWith('displayEmbeds.rankSuccess', mockEventData.lang);
        expect(sentEmbed.addFields).toHaveBeenCalledTimes(4);

        // Player 123 (Winner 1)
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: '<@User123> (Winner)',
            value: 'Old: Elo=1167, μ=25.00, σ=8.33\nNew: Elo=1517, μ=27.00, σ=7.00',
            inline: false,
        });
        // Player 456 (Winner 2)
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: '<@User456> (Winner)',
            value: 'Old: Elo=1400, μ=22.00, σ=6.00\nNew: Elo=1552, μ=24.00, σ=5.80',
            inline: false,
        });
        // Player 789 (Loser 1)
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: '<@User789> (Loser)',
            value: 'Old: Elo=2100, μ=28.00, σ=4.00\nNew: Elo=2001, μ=26.00, σ=3.90',
            inline: false,
        });
        // Player 101 (Loser 2)
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: '<@User101> (Loser)',
            value: 'Old: Elo=1167, μ=25.00, σ=8.33\nNew: Elo=1283, μ=23.00, σ=7.00',
            inline: false,
        });
    });

    it('should handle database errors when fetching ratings', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> l');
        mockPlayerRatingFindOneFn.mockRejectedValue(new Error('Database connection error'));

        await expect(rankCommand.execute(mockIntr, mockEventData)).rejects.toThrow('Database connection error');

        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledTimes(1);
        expect(rateMock).not.toHaveBeenCalled();
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();
        expect(interactionUtilsSendMock).not.toHaveBeenCalled();
    });

    it('should handle database errors when upserting ratings', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> l');
        mockPlayerRatingFindOneFn.mockResolvedValue(null as any); // Both players are new or not found

        const mockInitialRating: OpenSkillRating = { mu: 25, sigma: 25 / 3 };
        ratingMock.mockReturnValue(mockInitialRating);

        const mockNewRatingP1: OpenSkillRating = { mu: 28, sigma: 7 };
        const mockNewRatingP2: OpenSkillRating = { mu: 18, sigma: 4.8 };
        rateMock.mockReturnValue([
            [mockNewRatingP1],
            [mockNewRatingP2],
        ]);

        mockPlayerRatingUpsertFn.mockRejectedValueOnce(new Error('Failed to upsert'));

        await expect(rankCommand.execute(mockIntr, mockEventData)).rejects.toThrow('Failed to upsert');

        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledTimes(2); // Attempted to find both players
        expect(rateMock).toHaveBeenCalledOnce();
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledTimes(1); // Attempted to upsert the first player then errored
        expect(interactionUtilsSendMock).not.toHaveBeenCalled();
    });
});