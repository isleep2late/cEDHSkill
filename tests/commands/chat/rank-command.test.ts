/// <reference types="vitest/globals" />
import type { PlayerRatingInstance } from '../../../src/models/db/player-rating.js';
import {
    ChatInputCommandInteraction,
    EmbedBuilder,
    Locale,
    CacheType,
    User,
    Message,
} from 'discord.js';
import { Rating as OpenSkillRating } from 'openskill';
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';

import { RankCommand } from '../../../src/commands/chat/rank-command.js';
import { PlayerRating } from '../../../src/db.js';
import { EventData } from '../../../src/models/internal-models.js';
import { RatingUtils } from '../../../src/utils/rating-utils.js';

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

// Mock for utils/interaction-utils.js
vi.mock('../../../src/utils/interaction-utils.js', () => ({
    InteractionUtils: {
        send: vi.fn(),
        editReply: vi.fn(), // Added for potential use in reaction handler tests
    },
}));

vi.mock('../../../src/utils/message-utils.js', () => ({
    MessageUtils: {
        react: vi.fn().mockResolvedValue(undefined),
        clearReactions: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../../../src/constants/index.js', async () => {
    const actual = await vi.importActual('../../../src/constants/index.js');
    return {
        ...actual, // Spread actual to keep other constants like DiscordLimits
        GameConstants: {
            RANK_UPVOTES_REQUIRED: 3,
            RANK_UPVOTE_EMOJI: '👍',
        },
    };
});

// Mock for discord.js
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
    let messageUtilsReactMock: MockedFunction<any>;
    let ratingMock: MockedFunction<any>;
    let rateMock: MockedFunction<any>;
    let mockClientUsersFetch: MockedFunction<(id: string) => Promise<User | null>>;
    let currentMockEmbed: EmbedBuilder;
    let mockPlayerRatingFindOneFn: MockedFunction<typeof PlayerRating.findOne>;
    let mockPlayerRatingUpsertFn: MockedFunction<typeof PlayerRating.upsert>;
    const MOCK_MESSAGE_ID = 'mockMessageId123';

    beforeEach(async () => {
        RankCommand.pendingRankUpdates.clear(); // Clear pending updates before each test
        rankCommand = new RankCommand();

        const { PlayerRating: MockedPlayerRating } = await import('../../../src/db.js');
        mockPlayerRatingFindOneFn = MockedPlayerRating.findOne as MockedFunction<
            typeof PlayerRating.findOne
        >;
        mockPlayerRatingUpsertFn = MockedPlayerRating.upsert as MockedFunction<
            typeof PlayerRating.upsert
        >;

        const { Lang } = await import('../../../src/services/lang.js');
        langGetRefMock = Lang.getRef as MockedFunction<any>;
        langGetEmbedMock = Lang.getEmbed as MockedFunction<any>;

        const { InteractionUtils } = await import('../../../src/utils/interaction-utils.js');
        interactionUtilsSendMock = InteractionUtils.send as MockedFunction<any>;
        interactionUtilsSendMock.mockResolvedValue({ id: MOCK_MESSAGE_ID } as Message);

        const { MessageUtils: MockedMessageUtils } = await import(
            '../../../src/utils/message-utils.js'
        );
        messageUtilsReactMock = MockedMessageUtils.react as MockedFunction<any>;

        const { rating, rate } = await import('openskill');
        ratingMock = rating as MockedFunction<any>;
        rateMock = rate as MockedFunction<any>;

        currentMockEmbed = new EmbedBuilder();
        langGetEmbedMock.mockReturnValue(currentMockEmbed);

        langGetRefMock.mockImplementation((keyInput: any, _lang?: any, vars?: any): string => {
            const key = keyInput as string;
            if (key === 'fields.provisionalRatings') return 'Provisional Ratings';
            if (key === 'fields.confirmedRatings') return 'Confirmed Ratings';
            if (key === 'arguments.results') return 'results';
            if (key === 'terms.winner') return 'Winner';
            if (key === 'terms.loser') return 'Loser';
            if (key === 'displayEmbeds.rankProvisional.description') {
                return `Proposed. React with ${vars.UPVOTE_EMOJI}. ${vars.UPVOTES_REQUIRED} needed. Current: ${vars.CURRENT_UPVOTES}`;
            }
            return key || '';
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
            if (id === '123')
                return { id: '123', username: 'User123', tag: 'User123#0001' } as User;
            if (id === '456')
                return { id: '456', username: 'User456', tag: 'User456#0002' } as User;
            if (id === '789')
                return { id: '789', username: 'User789', tag: 'User789#0003' } as User;
            if (id === '101')
                return { id: '101', username: 'User101', tag: 'User101#0004' } as User;
            return null;
        });

        mockIntr = {
            options: {
                getString: vi.fn(),
                // ... other option methods if needed
            },
            user: { id: 'testUser' } as User,
            guild: { id: MOCK_GUILD_ID, name: 'Test Guild' },
            client: {
                user: { id: 'botId' } as User,
                users: { fetch: mockClientUsersFetch },
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
                sigma: r?.sigma ?? 25 / 3,
            };
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        RankCommand.pendingRankUpdates.clear();
    });

    it('should parse input, send provisional embed, react, and store pending update for 1v1', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> l');
        const { GameConstants } = await import('../../../src/constants/index.js');

        const existingPlayerDbData = {
            userId: '456',
            guildId: MOCK_GUILD_ID,
            mu: 20,
            sigma: 5,
            wins: 2,
            losses: 3,
        };
        mockPlayerRatingFindOneFn
            .mockResolvedValueOnce(null as any) // P1 new player
            .mockResolvedValueOnce(existingPlayerDbData as unknown as PlayerRatingInstance); // P2 existing

        const mockInitialRatingP1: OpenSkillRating = { mu: 25, sigma: 25 / 3 };
        const mockInitialRatingP2FromDB: OpenSkillRating = { mu: 20, sigma: 5 };
        ratingMock.mockImplementation((configInput?: unknown): OpenSkillRating => {
            const config = configInput as { mu: number; sigma: number } | undefined;
            if (config && config.mu === 20 && config.sigma === 5) return mockInitialRatingP2FromDB;
            return mockInitialRatingP1;
        });

        const mockNewRatingP1: OpenSkillRating = { mu: 28, sigma: 7 };
        const mockNewRatingP2: OpenSkillRating = { mu: 18, sigma: 4.8 };
        rateMock.mockReturnValue([[mockNewRatingP1], [mockNewRatingP2]]);

        await rankCommand.execute(mockIntr, mockEventData);

        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledWith({
            where: { userId: '123', guildId: MOCK_GUILD_ID },
        });
        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledWith({
            where: { userId: '456', guildId: MOCK_GUILD_ID },
        });
        expect(rateMock).toHaveBeenCalledWith([[mockInitialRatingP1], [mockInitialRatingP2FromDB]]);

        // Ensure DB upsert is NOT called directly
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();

        // Check provisional embed
        const sentEmbed = interactionUtilsSendMock.mock.calls[0][1] as EmbedBuilder;
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.rankProvisional',
            mockEventData.lang,
            {
                UPVOTES_REQUIRED: GameConstants.RANK_UPVOTES_REQUIRED.toString(),
                UPVOTE_EMOJI: GameConstants.RANK_UPVOTE_EMOJI,
                CURRENT_UPVOTES: '0',
            }
        );
        expect(sentEmbed.setTitle).toHaveBeenCalledWith('Provisional Ratings'); // From langGetRefMock
        expect(sentEmbed.addFields).toHaveBeenCalledTimes(2);

        // Player 123 (Winner)
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: 'User123#0001 (Winner)',
            value: `Old: Elo=${RatingUtils.calculateElo(25, 25 / 3)}, μ=25.00, σ=8.33, W/L: 0/0\nNew: Elo=${RatingUtils.calculateElo(28, 7)}, μ=28.00, σ=7.00, W/L: 1/0`,
            inline: false,
        });
        // Player 456 (Loser)
        expect(sentEmbed.addFields).toHaveBeenCalledWith({
            name: 'User456#0002 (Loser)',
            value: `Old: Elo=${RatingUtils.calculateElo(20, 5)}, μ=20.00, σ=5.00, W/L: 2/3\nNew: Elo=${RatingUtils.calculateElo(18, 4.8)}, μ=18.00, σ=4.80, W/L: 2/4`,
            inline: false,
        });

        // Check reaction
        expect(messageUtilsReactMock).toHaveBeenCalledWith(
            { id: MOCK_MESSAGE_ID },
            GameConstants.RANK_UPVOTE_EMOJI
        );

        // Check pending update storage
        expect(RankCommand.pendingRankUpdates.has(MOCK_MESSAGE_ID)).toBe(true);
        const pendingUpdate = RankCommand.pendingRankUpdates.get(MOCK_MESSAGE_ID);
        expect(pendingUpdate).toBeDefined();
        expect(pendingUpdate?.guildId).toBe(MOCK_GUILD_ID);
        expect(pendingUpdate?.interaction).toBe(mockIntr);
        expect(pendingUpdate?.lang).toBe(mockEventData.lang);
        expect(pendingUpdate?.upvoters.size).toBe(0);
        expect(pendingUpdate?.playersToUpdate).toHaveLength(2);

        const player1Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '123');
        expect(player1Update).toEqual(
            expect.objectContaining({
                userId: '123',
                status: 'w',
                tag: 'User123#0001',
                initialRating: mockInitialRatingP1,
                initialElo: RatingUtils.calculateElo(25, 25 / 3),
                initialWins: 0,
                initialLosses: 0,
                newRating: mockNewRatingP1,
                newWins: 1,
                newLosses: 0,
            })
        );

        const player2Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '456');
        expect(player2Update).toEqual(
            expect.objectContaining({
                userId: '456',
                status: 'l',
                tag: 'User456#0002',
                initialRating: mockInitialRatingP2FromDB,
                initialElo: RatingUtils.calculateElo(20, 5),
                initialWins: existingPlayerDbData.wins,
                initialLosses: existingPlayerDbData.losses,
                newRating: mockNewRatingP2,
                newWins: existingPlayerDbData.wins,
                newLosses: existingPlayerDbData.losses + 1,
            })
        );
    });

    it('should send "guild only" error if command is used outside a guild', async () => {
        const intrNoGuild = {
            ...mockIntr,
            guild: null,
        } as unknown as ChatInputCommandInteraction<CacheType>;
        (intrNoGuild.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> l');

        await rankCommand.execute(intrNoGuild, mockEventData);

        expect(interactionUtilsSendMock).toHaveBeenCalledWith(intrNoGuild, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'errorEmbeds.commandNotInGuild',
            mockEventData.lang
        );
        expect(mockPlayerRatingFindOneFn).not.toHaveBeenCalled();
        expect(RankCommand.pendingRankUpdates.size).toBe(0);
    });

    it('should send "not enough players" error for single player input', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w');
        await rankCommand.execute(mockIntr, mockEventData);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'validationEmbeds.rankNotEnoughPlayers',
            mockEventData.lang
        );
        expect(RankCommand.pendingRankUpdates.size).toBe(0);
    });

    it('should send "parsing error" if no players are parsed but input is not empty', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('invalid string');
        await rankCommand.execute(mockIntr, mockEventData);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'validationEmbeds.rankErrorParsing',
            mockEventData.lang
        );
        expect(RankCommand.pendingRankUpdates.size).toBe(0);
    });

    it('should send "invalid outcome" if only winners are provided', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> w');
        mockPlayerRatingFindOneFn.mockResolvedValue({
            userId: 'any',
            guildId: MOCK_GUILD_ID,
            mu: 25,
            sigma: 8,
            wins: 0,
            losses: 0,
        } as any);
        await rankCommand.execute(mockIntr, mockEventData);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed, true);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'validationEmbeds.rankInvalidOutcome',
            mockEventData.lang
        );
        expect(RankCommand.pendingRankUpdates.size).toBe(0);
    });

    it('should correctly parse multiple winners/losers, store pending update', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue(
            '<@123> w <@456> w <@789> l <@101> l'
        );
        const { GameConstants } = await import('../../../src/constants/index.js');

        const dbDataP2 = {
            userId: '456',
            guildId: MOCK_GUILD_ID,
            mu: 22,
            sigma: 6,
            wins: 5,
            losses: 2,
        };
        const dbDataP3 = {
            userId: '789',
            guildId: MOCK_GUILD_ID,
            mu: 28,
            sigma: 4,
            wins: 10,
            losses: 1,
        };
        mockPlayerRatingFindOneFn
            .mockResolvedValueOnce(null as any) // P1
            .mockResolvedValueOnce(dbDataP2 as unknown as PlayerRatingInstance) // P2
            .mockResolvedValueOnce(dbDataP3 as unknown as PlayerRatingInstance) // P3
            .mockResolvedValueOnce(null as any); // P4

        const initialRatingsMap: { [key: string]: OpenSkillRating } = {
            '123': { mu: 25, sigma: 25 / 3 },
            '456': { mu: 22, sigma: 6 },
            '789': { mu: 28, sigma: 4 },
            '101': { mu: 25, sigma: 25 / 3 },
        };
        ratingMock.mockImplementation((configInput?: unknown): OpenSkillRating => {
            const config = configInput as { mu: number; sigma: number } | undefined;
            if (!config) return initialRatingsMap['123'];
            if (config.mu === 22 && config.sigma === 6) return initialRatingsMap['456'];
            if (config.mu === 28 && config.sigma === 4) return initialRatingsMap['789'];
            return initialRatingsMap['101'];
        });

        const updatedRatingsMock: { [key: string]: OpenSkillRating } = {
            '123': { mu: 27, sigma: 7 },
            '456': { mu: 24, sigma: 5.8 },
            '789': { mu: 26, sigma: 3.9 },
            '101': { mu: 23, sigma: 7 },
        };
        rateMock.mockReturnValue([
            [updatedRatingsMock['123'], updatedRatingsMock['456']],
            [updatedRatingsMock['789'], updatedRatingsMock['101']],
        ]);

        await rankCommand.execute(mockIntr, mockEventData);

        expect(rateMock).toHaveBeenCalledWith([
            [initialRatingsMap['123'], initialRatingsMap['456']],
            [initialRatingsMap['789'], initialRatingsMap['101']],
        ]);
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();

        const sentEmbed = interactionUtilsSendMock.mock.calls[0][1] as EmbedBuilder;
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.rankProvisional',
            mockEventData.lang,
            expect.any(Object)
        );
        expect(sentEmbed.addFields).toHaveBeenCalledTimes(4);

        expect(messageUtilsReactMock).toHaveBeenCalledWith(
            { id: MOCK_MESSAGE_ID },
            GameConstants.RANK_UPVOTE_EMOJI
        );
        expect(RankCommand.pendingRankUpdates.has(MOCK_MESSAGE_ID)).toBe(true);
        const pendingUpdate = RankCommand.pendingRankUpdates.get(MOCK_MESSAGE_ID);
        expect(pendingUpdate?.playersToUpdate).toHaveLength(4);

        // P1 (winner)
        const p1Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '123');
        expect(p1Update).toEqual(
            expect.objectContaining({
                newWins: 1,
                newLosses: 0,
                newRating: updatedRatingsMock['123'],
            })
        );
        // P2 (winner)
        const p2Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '456');
        expect(p2Update).toEqual(
            expect.objectContaining({
                newWins: dbDataP2.wins + 1,
                newLosses: dbDataP2.losses,
                newRating: updatedRatingsMock['456'],
            })
        );
        // P3 (loser)
        const p3Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '789');
        expect(p3Update).toEqual(
            expect.objectContaining({
                newWins: dbDataP3.wins,
                newLosses: dbDataP3.losses + 1,
                newRating: updatedRatingsMock['789'],
            })
        );
        // P4 (loser)
        const p4Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '101');
        expect(p4Update).toEqual(
            expect.objectContaining({
                newWins: 0,
                newLosses: 1,
                newRating: updatedRatingsMock['101'],
            })
        );
    });

    it('should default wins/losses to 0 in pending update if db record has them as null/undefined', async () => {
        (mockIntr.options.getString as MockedFunction<any>).mockReturnValue('<@123> w <@456> l');

        mockPlayerRatingFindOneFn
            .mockResolvedValueOnce({
                userId: '123',
                guildId: MOCK_GUILD_ID,
                mu: 25,
                sigma: 8,
                wins: null,
                losses: undefined,
            } as unknown as PlayerRatingInstance) // P1 existing with null/undefined W/L
            .mockResolvedValueOnce(null as any); // P2 new player

        const mockInitialRatingP1FromDB: OpenSkillRating = { mu: 25, sigma: 8 };
        const mockInitialRatingP2New: OpenSkillRating = { mu: 25, sigma: 25 / 3 };
        ratingMock.mockImplementation((configInput?: unknown): OpenSkillRating => {
            const config = configInput as { mu: number; sigma: number } | undefined;
            if (config && config.mu === 25 && config.sigma === 8) return mockInitialRatingP1FromDB;
            return mockInitialRatingP2New;
        });

        const mockNewRatingP1: OpenSkillRating = { mu: 28, sigma: 7 };
        const mockNewRatingP2: OpenSkillRating = { mu: 22, sigma: 7.5 };
        rateMock.mockReturnValue([[mockNewRatingP1], [mockNewRatingP2]]);

        await rankCommand.execute(mockIntr, mockEventData);
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();

        const pendingUpdate = RankCommand.pendingRankUpdates.get(MOCK_MESSAGE_ID);
        expect(pendingUpdate).toBeDefined();

        const player1Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '123');
        expect(player1Update).toEqual(
            expect.objectContaining({
                initialWins: 0, // Defaulted from null
                initialLosses: 0, // Defaulted from undefined
                newWins: 1,
                newLosses: 0,
            })
        );

        const player2Update = pendingUpdate?.playersToUpdate.find(p => p.userId === '456');
        expect(player2Update).toEqual(
            expect.objectContaining({
                initialWins: 0, // New player
                initialLosses: 0, // New player
                newWins: 0,
                newLosses: 1,
            })
        );

        const sentEmbed = interactionUtilsSendMock.mock.calls[0][1] as EmbedBuilder;
        // Player 123 (Winner) - initial W/L was 0/0
        expect(sentEmbed.addFields).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'User123#0001 (Winner)',
                value:
                    expect.stringContaining('Old: Elo=1225, μ=25.00, σ=8.00, W/L: 0/0') &&
                    expect.stringContaining('New: Elo=1575, μ=28.00, σ=7.00, W/L: 1/0'),
            })
        );
        // Player 456 (Loser) - initial W/L was 0/0
        expect(sentEmbed.addFields).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'User456#0002 (Loser)',
                value:
                    expect.stringContaining('Old: Elo=1167, μ=25.00, σ=8.33, W/L: 0/0') &&
                    expect.stringContaining('New: Elo=1137, μ=22.00, σ=7.50, W/L: 0/1'),
            })
        );
    });
});
