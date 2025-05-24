/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import { ChatInputCommandInteraction, EmbedBuilder, User, CacheType, Locale } from 'discord.js';

import { PlayerInfoCommand } from '../../../src/commands/chat/playerinfo-command.js';
import type { PlayerRatingModelStatic, PlayerRatingInstance } from '../../../src/models/db/player-rating.js';
import { PlayerRating } from '../../../src/db.js';
import { EventData } from '../../../src/models/internal-models.js';
import { RatingUtils } from '../../../src/utils/rating-utils.js';

// --- Mocking Section ---

// Mock for db.js
vi.mock('../../../src/db.js', () => ({
    PlayerRating: {
        findOne: vi.fn(),
    },
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
    },
}));

// Mock for discord.js (specifically EmbedBuilder and Locale)
vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');
    const MockedEmbedBuilder = vi.fn(() => ({
        setTitle: vi.fn().mockReturnThis(),
        setDescription: vi.fn().mockReturnThis(),
        addFields: vi.fn().mockReturnThis(),
        setColor: vi.fn().mockReturnThis(),
        setThumbnail: vi.fn().mockReturnThis(),
        setAuthor: vi.fn().mockReturnThis(),
        setFooter: vi.fn().mockReturnThis(),
        setTimestamp: vi.fn().mockReturnThis(),
    }));
    return {
        ...actual,
        EmbedBuilder: MockedEmbedBuilder, // Use the correctly defined mock
        Locale: actual.Locale,
    };
});

// --- Test Suite ---

describe('PlayerInfoCommand', () => {
    let playerInfoCommand: PlayerInfoCommand;
    let mockIntr: ChatInputCommandInteraction<CacheType>;
    let mockEventData: EventData;
    let mockUser: User;
    const MOCK_GUILD_ID = 'testGuildId';

    let currentMockEmbed: EmbedBuilder;
    let langGetRefMock: MockedFunction<any>;
    let langGetEmbedMock: MockedFunction<any>;
    let mockPlayerRatingFindOneFn: MockedFunction<typeof PlayerRating.findOne>;
    let interactionUtilsSendMock: MockedFunction<any>;


    beforeEach(async () => { // Make beforeEach async if it needs to await imports
        playerInfoCommand = new PlayerInfoCommand();
        
        // Dynamically import mocked modules to get their mock functions
        const { PlayerRating: MockedPlayerRating } = await import('../../../src/db.js');
        mockPlayerRatingFindOneFn = MockedPlayerRating.findOne as MockedFunction<typeof PlayerRating.findOne>;

        const { Lang } = await import('../../../src/services/lang.js');
        langGetRefMock = Lang.getRef as MockedFunction<any>;
        langGetEmbedMock = Lang.getEmbed as MockedFunction<any>;

        const { InteractionUtils: MockedInteractionUtils } = await import('../../../src/utils/interaction-utils.js');
        interactionUtilsSendMock = MockedInteractionUtils.send as MockedFunction<any>;


        // Clear mocks
        langGetRefMock.mockClear();
        langGetEmbedMock.mockClear();
        interactionUtilsSendMock.mockClear();
        mockPlayerRatingFindOneFn.mockReset();


        currentMockEmbed = new EmbedBuilder(); // This will use the mocked EmbedBuilder
        langGetEmbedMock.mockReturnValue(currentMockEmbed);


        mockUser = {
            id: 'testUserId',
            tag: 'TestUser#1234',
            username: 'TestUser',
            toString: () => `<@${mockUser.id}>`,
        } as User;

        mockEventData = {
            lang: Locale.EnglishUS,
        } as EventData;

        mockIntr = {
            options: {
                getUser: vi.fn().mockReturnValue(mockUser),
            },
            user: mockUser,
            guild: {
                id: MOCK_GUILD_ID,
                name: 'Mock Server',
            },
            channel: {},
            locale: Locale.EnglishUS,
            reply: vi.fn(),
            deferReply: vi.fn(),
            editReply: vi.fn(),
            followUp: vi.fn(),
            channelId: 'mockChannelId',
            commandName: 'playerinfo',
            isCommand: () => true,
            isChatInputCommand: () => true,
        } as unknown as ChatInputCommandInteraction<CacheType>;

        langGetRefMock.mockImplementation(((key: string, lang: Locale | undefined, _vars: any) => {
            if (key === 'arguments.user') {
                return lang === Locale.French ? 'utilisateur' : 'user';
            }
            return key;
        }) as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should correctly retrieve and display player info if player exists in the guild', async () => {
        const mockPlayerData = {
            userId: 'testUserId',
            guildId: MOCK_GUILD_ID,
            mu: 25.0000,
            sigma: 8.3333,
        } as PlayerRatingInstance;
        mockPlayerRatingFindOneFn.mockResolvedValue(mockPlayerData as any);
        const expectedElo = RatingUtils.calculateElo(mockPlayerData.mu, mockPlayerData.sigma);

        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(mockIntr.options.getUser).toHaveBeenCalledWith('user', true);
        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledWith({ where: { userId: 'testUserId', guildId: MOCK_GUILD_ID } });

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoFound',
            mockEventData.lang,
            {
                USER_TAG: 'TestUser#1234',
                ELO: expectedElo.toString(),
                SIGMA: '8.3333',
                MU: '25.0000',
            }
        );

        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });

    it('should display "unrated" if player does not exist in the database for the guild', async () => {
        mockPlayerRatingFindOneFn.mockResolvedValue(null as any);

        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(mockIntr.options.getUser).toHaveBeenCalledWith('user', true);
        expect(mockPlayerRatingFindOneFn).toHaveBeenCalledWith({ where: { userId: 'testUserId', guildId: MOCK_GUILD_ID } });

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoUnrated',
            mockEventData.lang,
            {
                USER_TAG: 'TestUser#1234',
            }
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });

    it('should send "guild only" error if command is used outside a guild', async () => {
        const intrNoGuild = {
            ...mockIntr,
            guild: null,
        } as unknown as ChatInputCommandInteraction<CacheType>;

        await playerInfoCommand.execute(intrNoGuild, mockEventData);

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'errorEmbeds.commandNotInGuild', // Corrected key based on lang files
            mockEventData.lang
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(intrNoGuild, currentMockEmbed, true);
        expect(mockPlayerRatingFindOneFn).not.toHaveBeenCalled();
    });


    it('should use data.lang for retrieving argument name if provided', async () => {
        mockEventData.lang = Locale.French;
        mockPlayerRatingFindOneFn.mockResolvedValue(null as any);


        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(mockIntr.options.getUser).toHaveBeenCalledWith('utilisateur', true);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoUnrated',
            Locale.French,
            {
                USER_TAG: 'TestUser#1234',
            }
        );
    });

    it('should correctly format mu and sigma to 4 decimal places', async () => {
        const mockPlayerData = {
            userId: 'testUserId',
            guildId: MOCK_GUILD_ID,
            mu: 25.1234567,
            sigma: 8.9876543,
        } as PlayerRatingInstance;
        mockPlayerRatingFindOneFn.mockResolvedValue(mockPlayerData as any);
        const expectedElo = RatingUtils.calculateElo(mockPlayerData.mu, mockPlayerData.sigma);

        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoFound',
            mockEventData.lang,
            {
                USER_TAG: 'TestUser#1234',
                ELO: expectedElo.toString(),
                SIGMA: '8.9877',
                MU: '25.1235',
            }
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });
});