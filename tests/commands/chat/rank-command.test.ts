/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach, Mocked } from 'vitest';
import { ChatInputCommandInteraction, EmbedBuilder, Locale, CacheType } from 'discord.js';
import { rating, rate, Rating as OpenSkillRating } from 'openskill';

import { RankCommand } from '../../../src/commands/chat/rank-command.js';
import type { PlayerRatingModelStatic, PlayerRatingInstance } from '../../../src/models/db/player-rating.js';
// The PlayerRating will be the mocked version due to vi.mock below
import { PlayerRating } from '../../../src/db.js';
import { Lang } from '../../../src/services/lang.js';
import { InteractionUtils } from '../../../src/utils/interaction-utils.js';
import { EventData } from '../../../src/models/internal-models.js';
import { Language } from '../../../src/models/enum-helpers/index.js';

// Mock dependencies
vi.mock('openskill', () => ({
    rating: vi.fn(),
    rate: vi.fn(),
}));

// Mock the db module. This will provide mocked versions of PlayerRating's methods.
vi.mock('../../../src/db.js', () => ({
    PlayerRating: {
        findOne: vi.fn(),
        upsert: vi.fn(),
    },
    initializeDatabase: vi.fn().mockResolvedValue(undefined),
    sequelize: {}, // Mock sequelize if it's directly accessed, though not in this test
}));

vi.mock('../../../src/services/lang.js', () => ({
    Lang: {
        getRef: vi.fn((key, _lang) => key), // Return key for simplicity in tests
        getEmbed: vi.fn((key, _lang, _vars) => {
            const mockEmbed = new EmbedBuilder();
            vi.spyOn(mockEmbed, 'addFields');
            vi.spyOn(mockEmbed, 'setTitle');
            (mockEmbed as any)._key = key; // Store key for assertion
            return mockEmbed;
        }),
        getRefLocalizationMap: vi.fn(() => ({})),
    },
}));

vi.mock('../../../src/utils/interaction-utils.js', () => ({
    InteractionUtils: {
        send: vi.fn(),
    },
}));

describe('RankCommand', () => {
    let rankCommand: RankCommand;
    let mockIntr: ChatInputCommandInteraction<CacheType>;
    let mockEventData: EventData;

    beforeEach(() => {
        // PlayerRating is already the mocked version due to vi.mock at the top level
        // Reset mocks before each test
        (PlayerRating.findOne as Mocked<PlayerRatingModelStatic['findOne']>).mockReset();
        (PlayerRating.upsert as Mocked<PlayerRatingModelStatic['upsert']>).mockReset();
        (Lang.getRef as vi.Mock).mockClear();
        (Lang.getEmbed as vi.Mock).mockClear();
        (InteractionUtils.send as vi.Mock).mockClear();
        (rating as vi.Mock).mockClear();
        (rate as vi.Mock).mockClear();

        rankCommand = new RankCommand();
        mockEventData = new EventData(Locale.EnglishUS, Locale.EnglishUS);

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
            user: { id: 'testUser' },
            guild: { id: 'testGuild' },
            client: { user: { id: 'botId' } },
            reply: vi.fn().mockResolvedValue({}),
            editReply: vi.fn().mockResolvedValue({}),
            deferReply: vi.fn().mockResolvedValue({}),
            followUp: vi.fn().mockResolvedValue({}),
            deferred: false,
            replied: false,
            channelId: 'mockChannelId',
            commandName: 'rank',
        } as unknown as ChatInputCommandInteraction<CacheType>;

        (rating as vi.Mock<[(OpenSkillRating | { mu: number; sigma: number } | undefined)?], OpenSkillRating>).mockImplementation((r?) => ({
            mu: r?.mu ?? 25,
            sigma: r?.sigma ?? 25 / 3,
        }));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should correctly parse input, update ratings for 1v1, and send success embed', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue('<@123> w <@456> l');

        PlayerRating.findOne
            .mockResolvedValueOnce(null) // Player 123 is new
            .mockResolvedValueOnce({ userId: '456', mu: 20, sigma: 5 } as unknown as PlayerRatingInstance); // Player 456 exists

        const mockInitialRatingP1: OpenSkillRating = { mu: 25, sigma: 25 / 3 };
        const mockInitialRatingP2FromDB: OpenSkillRating = { mu: 20, sigma: 5 };
        (rating as vi.Mock<[(OpenSkillRating | { mu: number; sigma: number } | undefined)?], OpenSkillRating>).mockImplementation(config => {
            if (config && 'mu' in config && config.mu === 20 && config.sigma === 5) return mockInitialRatingP2FromDB;
            return mockInitialRatingP1; // For new player
        });

        const mockNewRatingP1: OpenSkillRating = { mu: 28, sigma: 7 };
        const mockNewRatingP2: OpenSkillRating = { mu: 18, sigma: 4.8 };
        (rate as vi.Mock<[OpenSkillRating[][]], OpenSkillRating[][]>).mockReturnValue([
            [mockNewRatingP1], // Updated ratings for winners
            [mockNewRatingP2], // Updated ratings for losers
        ]);

        await rankCommand.execute(mockIntr, mockEventData);

        expect(Lang.getRef).toHaveBeenCalledWith('arguments.results', mockEventData.lang);
        expect(PlayerRating.findOne).toHaveBeenCalledWith({ where: { userId: '123' } });
        expect(PlayerRating.findOne).toHaveBeenCalledWith({ where: { userId: '456' } });

        expect(rate).toHaveBeenCalledWith([
            [mockInitialRatingP1],
            [mockInitialRatingP2FromDB],
        ]);

        expect(PlayerRating.upsert).toHaveBeenCalledWith({ userId: '123', mu: 28, sigma: 7 });
        expect(PlayerRating.upsert).toHaveBeenCalledWith({ userId: '456', mu: 18, sigma: 4.8 });

        expect(InteractionUtils.send).toHaveBeenCalled();
        const sentEmbed = (InteractionUtils.send as vi.Mock).mock.calls[0][1];
        expect((sentEmbed as any)._key).toBe('displayEmbeds.rankSuccess');
        expect(sentEmbed.setTitle).toHaveBeenCalledWith('fields.updatedRatings');
        expect(sentEmbed.addFields).toHaveBeenCalledTimes(2);
    });

    it('should send "not enough players" error for single player input', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue('<@123> w');
        await rankCommand.execute(mockIntr, mockEventData);
        expect(InteractionUtils.send).toHaveBeenCalled();
        const sentEmbed = (InteractionUtils.send as vi.Mock).mock.calls[0][1];
        expect((sentEmbed as any)._key).toBe('displayEmbeds.rankNotEnoughPlayers');
        // Also check that DB and rate functions were NOT called
        expect(PlayerRating.findOne).not.toHaveBeenCalled();
        expect(rate as vi.Mock).not.toHaveBeenCalled();
        expect(PlayerRating.upsert).not.toHaveBeenCalled();
    });

    it('should send "parsing error" if no players are parsed but input is not empty', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue('this is not a valid result string');
        await rankCommand.execute(mockIntr, mockEventData);
        expect(InteractionUtils.send).toHaveBeenCalled();
        const sentEmbed = (InteractionUtils.send as vi.Mock).mock.calls[0][1];
        expect((sentEmbed as any)._key).toBe('displayEmbeds.rankErrorParsing');
        expect(PlayerRating.findOne).not.toHaveBeenCalled();
        expect(rate as vi.Mock).not.toHaveBeenCalled();
        expect(PlayerRating.upsert).not.toHaveBeenCalled();
    });

    it('should send "invalid outcome" if only winners are provided', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue('<@123> w <@456> w');
        (PlayerRating.findOne).mockResolvedValue({ userId: 'someId', mu: 25, sigma: 25/3 } as unknown as PlayerRatingInstance);
        await rankCommand.execute(mockIntr, mockEventData);
        expect(InteractionUtils.send).toHaveBeenCalled();
        const sentEmbed = (InteractionUtils.send as vi.Mock).mock.calls[0][1];
        expect((sentEmbed as any)._key).toBe('displayEmbeds.rankInvalidOutcome');
        expect(PlayerRating.findOne).toHaveBeenCalledTimes(2);
        expect(rate as vi.Mock).not.toHaveBeenCalled();
        expect(PlayerRating.upsert).not.toHaveBeenCalled();
    });

    it('should send "invalid outcome" if only losers are provided', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue('<@123> l <@456> l');
        (PlayerRating.findOne).mockResolvedValue({ userId: 'someId', mu: 25, sigma: 25/3 } as unknown as PlayerRatingInstance);
        await rankCommand.execute(mockIntr, mockEventData);
        expect(InteractionUtils.send).toHaveBeenCalled();
        const sentEmbed = (InteractionUtils.send as vi.Mock).mock.calls[0][1];
        expect((sentEmbed as any)._key).toBe('displayEmbeds.rankInvalidOutcome');
        expect(PlayerRating.findOne).toHaveBeenCalledTimes(2);
        expect(rate as vi.Mock).not.toHaveBeenCalled();
        expect(PlayerRating.upsert).not.toHaveBeenCalled();
    });

    it('should correctly parse multiple winners and losers', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue(
            '<@123> w <@456> w <@789> l <@101> l'
        );

        PlayerRating.findOne
            .mockResolvedValueOnce(null) // P1
            .mockResolvedValueOnce({ userId: '456', mu: 22, sigma: 6 } as unknown as PlayerRatingInstance) // P2
            .mockResolvedValueOnce({ userId: '789', mu: 28, sigma: 4 } as unknown as PlayerRatingInstance) // P3
            .mockResolvedValueOnce(null); // P4

        const initialRatings: { [key: string]: OpenSkillRating } = {
            p1: { mu: 25, sigma: 25 / 3 },
            p2: { mu: 22, sigma: 6 },
            p3: { mu: 28, sigma: 4 },
            p4: { mu: 25, sigma: 25 / 3 },
        };
        (rating as vi.Mock<[(OpenSkillRating | { mu: number; sigma: number } | undefined)?], OpenSkillRating>).mockImplementation(config => {
            if (!config) return { mu: 25, sigma: 25 / 3 };
            if ('mu' in config && config.mu === 22) return initialRatings.p2;
            if ('mu' in config && config.mu === 28) return initialRatings.p3;
            return { mu: 25, sigma: 25 / 3 };
        });
        const updatedRatingsMock: OpenSkillRating[] = [
            { mu: 27, sigma: 7 },    // P1 new rating
            { mu: 24, sigma: 5.8 },  // P2 new rating
            { mu: 26, sigma: 3.9 },  // P3 new rating
            { mu: 23, sigma: 7 },    // P4 new rating
        ];

        (rate as vi.Mock<[OpenSkillRating[][]], OpenSkillRating[][]>).mockReturnValue([
            [updatedRatingsMock[0], updatedRatingsMock[1]], // Winners
            [updatedRatingsMock[2], updatedRatingsMock[3]], // Losers
        ]);

        await rankCommand.execute(mockIntr, mockEventData);

        expect(rate as vi.Mock).toHaveBeenCalledWith([
            [initialRatings.p1, initialRatings.p2],
            [initialRatings.p3, initialRatings.p4],
        ]);

        expect(PlayerRating.upsert).toHaveBeenCalledWith({ userId: '123', ...updatedRatingsMock[0] });
        expect(PlayerRating.upsert).toHaveBeenCalledWith({ userId: '456', ...updatedRatingsMock[1] });
        expect(PlayerRating.upsert).toHaveBeenCalledWith({ userId: '789', ...updatedRatingsMock[2] });
        expect(PlayerRating.upsert).toHaveBeenCalledWith({ userId: '101', ...updatedRatingsMock[3] });

        expect(InteractionUtils.send).toHaveBeenCalled();
        const sentEmbed = (InteractionUtils.send as vi.Mock).mock.calls[0][1];
        expect((sentEmbed as any)._key).toBe('displayEmbeds.rankSuccess');
        expect(sentEmbed.addFields).toHaveBeenCalledTimes(4);
    });

    // Test case for when PlayerRating.findOne rejects (database error)
    it('should handle database errors when fetching ratings', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue('<@123> w <@456> l');
        PlayerRating.findOne.mockRejectedValue(new Error('Database connection error'));

        await expect(rankCommand.execute(mockIntr, mockEventData)).rejects.toThrow('Database connection error');

        expect(PlayerRating.findOne).toHaveBeenCalledTimes(1);
        expect(rate as vi.Mock).not.toHaveBeenCalled();
        expect(PlayerRating.upsert).not.toHaveBeenCalled();
        expect(InteractionUtils.send).not.toHaveBeenCalled();
    });

    // Test case for when PlayerRating.upsert rejects (database error)
    it('should handle database errors when upserting ratings', async () => {
        (mockIntr.options.getString as vi.Mock).mockReturnValue('<@123> w <@456> l');
        PlayerRating.findOne.mockResolvedValue(null); // Both new players

        const mockInitialRating: OpenSkillRating = { mu: 25, sigma: 25 / 3 };
        (rating as vi.Mock<[(OpenSkillRating | { mu: number; sigma: number } | undefined)?], OpenSkillRating>).mockReturnValue(mockInitialRating);


        const mockNewRatingP1: OpenSkillRating = { mu: 28, sigma: 7 };
        const mockNewRatingP2: OpenSkillRating = { mu: 18, sigma: 4.8 };
        (rate as vi.Mock<[OpenSkillRating[][]], OpenSkillRating[][]>).mockReturnValue([
            [mockNewRatingP1],
            [mockNewRatingP2],
        ]);

        PlayerRating.upsert.mockRejectedValueOnce(new Error('Failed to upsert')); // First upsert fails

        await expect(rankCommand.execute(mockIntr, mockEventData)).rejects.toThrow('Failed to upsert');

        expect(PlayerRating.findOne).toHaveBeenCalledTimes(2);
        expect(rate as vi.Mock).toHaveBeenCalledOnce();
        expect(PlayerRating.upsert).toHaveBeenCalledTimes(1);
        expect(InteractionUtils.send).not.toHaveBeenCalled();
    });
});