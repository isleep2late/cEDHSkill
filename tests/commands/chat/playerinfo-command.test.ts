/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach, Mocked } from 'vitest';
import { ChatInputCommandInteraction, EmbedBuilder, User, CacheType, Locale } from 'discord.js';

import { PlayerInfoCommand } from '../../../src/commands/chat/playerinfo-command.js';
import type { PlayerRatingModelStatic, PlayerRatingInstance } from '../../../src/models/db/player-rating.js';
// The PlayerRating will be the mocked version due to vi.mock below
import { PlayerRating } from '../../../src/db.js';
import { Lang } from '../../../src/services/lang.js';
import { InteractionUtils } from '../../../src/utils/interaction-utils.js';
import { EventData } from '../../../src/models/internal-models.js';
import { Language } from '../../../src/models/enum-helpers/index.js';

// Mock the PlayerRating model
vi.mock('../../../src/db.js', () => ({
    PlayerRating: {
        findOne: vi.fn(),
    },
}));

// Mock Lang service
vi.mock('../../../src/services/lang.js', () => ({
    Lang: {
        getRef: vi.fn(),
        getEmbed: vi.fn(),
        getComRef: vi.fn((key: string) => key), // Simple mock, might need adjustment if complex com refs are used
        getCom: vi.fn().mockReturnValue('{{COM_MOCK}}'),
        getRefLocalizationMap: vi.fn(() => ({})), // Add mock for getRefLocalizationMap
    },
}));

// Mock InteractionUtils
vi.mock('../../../src/utils/interaction-utils.js', () => ({
    InteractionUtils: {
        send: vi.fn(),
    },
}));

// Mock EmbedBuilder
vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');
    return {
        ...actual,
        EmbedBuilder: vi.fn(() => ({
            setTitle: vi.fn().mockReturnThis(),
            setDescription: vi.fn().mockReturnThis(),
            addFields: vi.fn().mockReturnThis(),
            setColor: vi.fn().mockReturnThis(),
            setThumbnail: vi.fn().mockReturnThis(),
            setAuthor: vi.fn().mockReturnThis(),
            setFooter: vi.fn().mockReturnThis(),
            setTimestamp: vi.fn().mockReturnThis(),
        })),
    };
});


describe('PlayerInfoCommand', () => {
    let playerInfoCommand: PlayerInfoCommand;
    let mockIntr: ChatInputCommandInteraction<CacheType>;
    let mockEventData: EventData;
    let mockUser: User;

    const mockPlayerRatingFindOne = PlayerRating.findOne as Mocked<PlayerRatingModelStatic['findOne']>;
    const mockLangGetRef = Lang.getRef as vi.Mock;
    const mockLangGetEmbed = Lang.getEmbed as vi.Mock;
    const mockInteractionUtilsSend = InteractionUtils.send as vi.Mock;
    const mockEmbedBuilder = EmbedBuilder as unknown as vi.Mock<() => EmbedBuilder>;
    let currentMockEmbed: Mocked<EmbedBuilder>;


    beforeEach(() => {
        playerInfoCommand = new PlayerInfoCommand();

        // Reset mocks before each test
        mockPlayerRatingFindOne.mockReset();
        mockLangGetRef.mockClear();
        mockLangGetEmbed.mockClear();
        mockInteractionUtilsSend.mockClear();
        mockEmbedBuilder.mockClear();

        // Setup a new mock embed for each test
        currentMockEmbed = {
            setTitle: vi.fn().mockReturnThis(),
            setDescription: vi.fn().mockReturnThis(),
            addFields: vi.fn().mockReturnThis(),
            setColor: vi.fn().mockReturnThis(),
            setThumbnail: vi.fn().mockReturnThis(),
            setAuthor: vi.fn().mockReturnThis(),
            setFooter: vi.fn().mockReturnThis(),
            setTimestamp: vi.fn().mockReturnThis(),
        } as Mocked<EmbedBuilder>;
        // Lang.getEmbed will return this mock embed
        mockLangGetEmbed.mockReturnValue(currentMockEmbed);


        mockUser = {
            id: 'testUserId',
            tag: 'TestUser#1234',
            username: 'TestUser',
            toString: () => `<@${mockUser.id}>`,
        } as User;

        mockEventData = {
            lang: Language.Default,
            // ... other event data properties if needed
        } as EventData;

        mockIntr = {
            options: {
                getUser: vi.fn().mockReturnValue(mockUser),
            },
            user: mockUser,
            guild: {
                id: 'mockGuildId',
                name: 'Mock Server',
                // ... other guild properties
            },
            channel: {
                // ... channel properties
            },
            locale: Locale.EnglishUS, // Default to en-US
            reply: vi.fn(), // Mock reply if used directly
            deferReply: vi.fn(), // Mock deferReply if used
            editReply: vi.fn(), // Mock editReply if used
            followUp: vi.fn(), // Mock followUp if used
            channelId: 'mockChannelId',
            commandName: 'playerinfo',
        } as unknown as ChatInputCommandInteraction<CacheType>;

        // Mock Lang.getRef specifically for argument names
        mockLangGetRef.mockImplementation((key, lang, _vars) => {
            if (key === 'arguments.user') {
                return lang === 'fr' ? 'utilisateur' : 'user';
            }
            // For other keys, return the key itself, or a more specific mock if needed elsewhere
            return key;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks(); // Restore all mocks to their original state
    });

    it('should correctly retrieve and display player info if player exists', async () => {
        const mockPlayerData = {
            userId: 'testUserId',
            mu: 25.0000,
            sigma: 8.3333,
        } as PlayerRatingInstance;
        mockPlayerRatingFindOne.mockResolvedValue(mockPlayerData);

        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(mockIntr.options.getUser).toHaveBeenCalledWith('user', true);
        expect(mockPlayerRatingFindOne).toHaveBeenCalledWith({ where: { userId: 'testUserId' } });

        expect(mockLangGetEmbed).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoFound',
            mockEventData.lang,
            {
                USER_TAG: 'TestUser#1234',
                SIGMA: '8.3333',
                MU: '25.0000',
            }
        );

        expect(InteractionUtils.send).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });

    it('should display "unrated" if player does not exist in the database', async () => {
        mockPlayerRatingFindOne.mockResolvedValue(null); // Player not found

        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(mockIntr.options.getUser).toHaveBeenCalledWith('user', true);
        expect(mockPlayerRatingFindOne).toHaveBeenCalledWith({ where: { userId: 'testUserId' } });

        expect(mockLangGetEmbed).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoUnrated',
            mockEventData.lang,
            {
                USER_TAG: 'TestUser#1234',
            }
        );
        expect(InteractionUtils.send).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });

    it('should use data.lang for retrieving argument name if provided', async () => {
        mockEventData.lang = 'fr' as Language; // Example other language
        // Lang.getRef is already configured in beforeEach to handle 'fr' for 'arguments.user'

        mockPlayerRatingFindOne.mockResolvedValue(null); // Player not found

        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(mockIntr.options.getUser).toHaveBeenCalledWith('utilisateur', true);
        expect(mockLangGetEmbed).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoUnrated',
            'fr', // ensure data.lang is used
            {
                USER_TAG: 'TestUser#1234',
            }
        );
    });

    it('should correctly format mu and sigma to 4 decimal places', async () => {
        const mockPlayerData = {
            userId: 'testUserId',
            mu: 25.1234567, // will be 25.1235
            sigma: 8.9876543, // will be 8.9877
        } as PlayerRatingInstance;
        mockPlayerRatingFindOne.mockResolvedValue(mockPlayerData);

        await playerInfoCommand.execute(mockIntr, mockEventData);

        expect(mockLangGetEmbed).toHaveBeenCalledWith(
            'displayEmbeds.playerInfoFound',
            mockEventData.lang,
            {
                USER_TAG: 'TestUser#1234',
                SIGMA: '8.9877', 
                MU: '25.1235',
            }
        );
        expect(InteractionUtils.send).toHaveBeenCalledWith(mockIntr, currentMockEmbed);
    });
});