/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import { Message, MessageReaction, User, EmbedBuilder, Locale, ChatInputCommandInteraction, PartialMessageReaction, PartialUser } from 'discord.js';
import { Rating as OpenSkillRating } from 'openskill';

import { RankConfirmationReaction } from '../../../src/reactions/rank-confirmation-reaction.ts';
import { RankCommand, PendingRankUpdate, ParsedPlayer } from '../../../src/commands/chat/rank-command.js';
import { GameConstants } from '../../../src/constants/index.js';
import { PlayerRating } from '../../../src/db.js';
import { EventData } from '../../../src/models/internal-models.js';
import { RatingUtils } from '../../../src/utils/rating-utils.js';

// --- Mocking Section ---
vi.mock('../../../src/db.js', () => ({
    PlayerRating: {
        upsert: vi.fn(),
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
        editReply: vi.fn(),
        send: vi.fn(), // For error fallback
    },
}));

vi.mock('../../../src/utils/message-utils.js', () => ({
    MessageUtils: {
        clearReactions: vi.fn(),
        edit: vi.fn(),
    },
}));

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
        toJSON: vi.fn().mockReturnValue({ description: 'Initial Description' }), // For reading existing embed
    }));
    return {
        ...actual,
        EmbedBuilder: MockedEmbedBuilder,
        Locale: actual.Locale,
        User: actual.User, // Ensure User constructor is available
        Message: actual.Message,
        MessageReaction: actual.MessageReaction,
    };
});

vi.mock('../../../src/constants/index.js', async () => {
    const actual = await vi.importActual('../../../src/constants/index.js');
    return {
        ...actual,
        GameConstants: {
            RANK_UPVOTES_REQUIRED: 3,
            RANK_UPVOTE_EMOJI: '👍',
        },
    };
});

// --- Test Suite ---
describe('RankConfirmationReaction', () => {
    let reactionHandler: RankConfirmationReaction;
    let mockMsgReaction: MessageReaction;
    let mockMsg: Message;
    let mockReactor: User;
    let mockEventData: EventData;
    let mockPendingUpdate: PendingRankUpdate;
    let mockPlayerRatingUpsertFn: MockedFunction<typeof PlayerRating.upsert>;
    let langGetRefMock: MockedFunction<any>;
    let langGetEmbedMock: MockedFunction<any>;
    let interactionUtilsEditReplyMock: MockedFunction<any>;
    let messageUtilsClearReactionsMock: MockedFunction<any>;
    let messageUtilsEditMock: MockedFunction<any>;
    let currentMockEmbed: EmbedBuilder;

    const MOCK_MESSAGE_ID = 'messageIdForPendingUpdate';
    const MOCK_GUILD_ID = 'guildIdForPendingUpdate';
    const MOCK_REACTOR_ID_1 = 'reactorId1';
    const MOCK_REACTOR_ID_2 = 'reactorId2';
    const MOCK_REACTOR_ID_3 = 'reactorId3';

    const mockPlayer1: ParsedPlayer = {
        userId: 'p1', status: 'w', tag: 'Player1#0001', initialWins: 0, initialLosses: 0,
        initialRating: { mu: 25, sigma: 8.33 }, initialElo: 0,
        newRating: { mu: 28, sigma: 7 }, newWins: 1, newLosses: 0,
    };
    const mockPlayer2: ParsedPlayer = {
        userId: 'p2', status: 'l', tag: 'Player2#0002', initialWins: 1, initialLosses: 1,
        initialRating: { mu: 20, sigma: 5 }, initialElo: -29,
        newRating: { mu: 18, sigma: 4.8 }, newWins: 1, newLosses: 2,
    };

    beforeEach(async () => {
        reactionHandler = new RankConfirmationReaction();
        RankCommand.pendingRankUpdates.clear();

        const { PlayerRating: MockedPlayerRatingDB } = await import('../../../src/db.js');
        mockPlayerRatingUpsertFn = MockedPlayerRatingDB.upsert as MockedFunction<typeof PlayerRating.upsert>;
        
        const { Lang: MockedLang } = await import('../../../src/services/lang.js');
        langGetRefMock = MockedLang.getRef as MockedFunction<any>;
        langGetEmbedMock = MockedLang.getEmbed as MockedFunction<any>;

        const { InteractionUtils: MockedInteractionUtils } = await import('../../../src/utils/interaction-utils.js');
        interactionUtilsEditReplyMock = MockedInteractionUtils.editReply as MockedFunction<any>;

        const { MessageUtils: MockedMessageUtils } = await import('../../../src/utils/message-utils.js');
        messageUtilsClearReactionsMock = MockedMessageUtils.clearReactions as MockedFunction<any>;
        messageUtilsEditMock = MockedMessageUtils.edit as MockedFunction<any>;


        currentMockEmbed = new EmbedBuilder();
        langGetEmbedMock.mockReturnValue(currentMockEmbed);
        langGetRefMock.mockImplementation((key: string, _lang?: Locale, vars?: any): string => {
            if (key === 'fields.confirmedRatings') return 'Confirmed Ratings';
            if (key === 'terms.winner') return 'Winner';
            if (key === 'terms.loser') return 'Loser';
            if (key === 'displayEmbeds.rankProvisional.descriptionUpdate') {
                 return `React with ${vars.UPVOTE_EMOJI}. ${vars.UPVOTES_REQUIRED} needed. Current: ${vars.CURRENT_UPVOTES} / ${vars.UPVOTES_REQUIRED}`;
            }
            return key;
        });


        mockReactor = new User(null as any, { id: MOCK_REACTOR_ID_1, bot: false, tag: 'Reactor#0001' });
        mockEventData = new EventData(Locale.EnglishUS, Locale.EnglishUS);

        mockMsg = {
            id: MOCK_MESSAGE_ID,
            guild: { id: MOCK_GUILD_ID },
            client: { user: { id: 'botId' } },
            embeds: [currentMockEmbed.toJSON() as any], // Simulate an existing embed
            reactions: {
                removeAll: messageUtilsClearReactionsMock,
            }
        } as unknown as Message;
        
        mockMsgReaction = {
            emoji: { name: GameConstants.RANK_UPVOTE_EMOJI },
            message: mockMsg,
            client: { user: { id: 'botId' } },
        } as MessageReaction;

        mockPendingUpdate = {
            guildId: MOCK_GUILD_ID,
            playersToUpdate: [mockPlayer1, mockPlayer2],
            interaction: {
                user: { id: 'interactionUserId' },
                guild: { id: MOCK_GUILD_ID },
                client: { user: { id: 'botId' } },
                followUp: vi.fn(), // For error sending
                editReply: interactionUtilsEditReplyMock,
            } as unknown as ChatInputCommandInteraction,
            lang: Locale.EnglishUS,
            upvoters: new Set(),
        };
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, mockPendingUpdate);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        RankCommand.pendingRankUpdates.clear();
    });

    it('should do nothing if reaction emoji is not the RANK_UPVOTE_EMOJI', async () => {
        mockMsgReaction.emoji.name = '👎';
        await reactionHandler.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);
        expect(RankCommand.pendingRankUpdates.get(MOCK_MESSAGE_ID)?.upvoters.size).toBe(0);
        expect(interactionUtilsEditReplyMock).not.toHaveBeenCalled();
    });

    it('should do nothing if no pending update for the message ID', async () => {
        RankCommand.pendingRankUpdates.delete(MOCK_MESSAGE_ID);
        await reactionHandler.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);
        expect(interactionUtilsEditReplyMock).not.toHaveBeenCalled();
    });

    it('should do nothing if reactor has already upvoted', async () => {
        mockPendingUpdate.upvoters.add(MOCK_REACTOR_ID_1);
        await reactionHandler.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);
        expect(mockPendingUpdate.upvoters.size).toBe(1); // Size should not change
        expect(interactionUtilsEditReplyMock).not.toHaveBeenCalled(); // No embed update expected
    });

    it('should add upvoter and update message if threshold not met', async () => {
        await reactionHandler.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(mockPendingUpdate.upvoters.has(MOCK_REACTOR_ID_1)).toBe(true);
        expect(mockPendingUpdate.upvoters.size).toBe(1);
        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(1);
        const updatedEmbed = interactionUtilsEditReplyMock.mock.calls[0][1] as EmbedBuilder;
        expect(updatedEmbed.setDescription).toHaveBeenCalledWith(
            `React with ${GameConstants.RANK_UPVOTE_EMOJI}. ${GameConstants.RANK_UPVOTES_REQUIRED} needed. Current: 1 / ${GameConstants.RANK_UPVOTES_REQUIRED}`
        );
        expect(mockPlayerRatingUpsertFn).not.toHaveBeenCalled();
    });

    it('should finalize update when upvote threshold is met', async () => {
        // Simulate previous upvotes
        mockPendingUpdate.upvoters.add('someOtherUser1');
        mockPendingUpdate.upvoters.add('someOtherUser2');
        // Reactor MOCK_REACTOR_ID_1 will be the 3rd unique upvote

        await reactionHandler.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(mockPendingUpdate.upvoters.has(MOCK_REACTOR_ID_1)).toBe(true);
        expect(mockPendingUpdate.upvoters.size).toBe(3); // Threshold met

        // Check DB upserts
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledTimes(2);
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({
            userId: mockPlayer1.userId, guildId: MOCK_GUILD_ID,
            mu: mockPlayer1.newRating.mu, sigma: mockPlayer1.newRating.sigma,
            wins: mockPlayer1.newWins, losses: mockPlayer1.newLosses,
        });
        expect(mockPlayerRatingUpsertFn).toHaveBeenCalledWith({
            userId: mockPlayer2.userId, guildId: MOCK_GUILD_ID,
            mu: mockPlayer2.newRating.mu, sigma: mockPlayer2.newRating.sigma,
            wins: mockPlayer2.newWins, losses: mockPlayer2.newLosses,
        });

        // Check message edit for confirmation
        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(1);
        const confirmedEmbed = interactionUtilsEditReplyMock.mock.calls[0][1] as EmbedBuilder;
        expect(langGetEmbedMock).toHaveBeenCalledWith('displayEmbeds.rankConfirmed', mockPendingUpdate.lang);
        expect(confirmedEmbed.setTitle).toHaveBeenCalledWith('Confirmed Ratings');
        expect(confirmedEmbed.addFields).toHaveBeenCalledTimes(2); // For player1 and player2

        // Check cleanup
        expect(RankCommand.pendingRankUpdates.has(MOCK_MESSAGE_ID)).toBe(false);
        expect(messageUtilsClearReactionsMock).toHaveBeenCalledWith(mockMsg);
    });

    it('should handle error during finalization and inform user', async () => {
        mockPendingUpdate.upvoters.add('user1');
        mockPendingUpdate.upvoters.add('user2');
        // Reactor MOCK_REACTOR_ID_1 will be the 3rd vote

        mockPlayerRatingUpsertFn.mockRejectedValueOnce(new Error('DB Error'));

        await reactionHandler.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(1);
        const errorEmbed = interactionUtilsEditReplyMock.mock.calls[0][1] as EmbedBuilder;
        expect(langGetEmbedMock).toHaveBeenCalledWith('errorEmbeds.rankUpdateFailed', mockPendingUpdate.lang);
        expect(RankCommand.pendingRankUpdates.has(MOCK_MESSAGE_ID)).toBe(false); // Cleaned up even on error
    });
    
    it('should correctly try to edit the message directly if editing interaction reply fails when updating count', async () => {
        // Simulate InteractionUtils.editReply failing
        interactionUtilsEditReplyMock.mockRejectedValueOnce(new Error("Interaction edit failed"));
        messageUtilsEditMock.mockResolvedValueOnce({} as Message); // Simulate direct message edit succeeding

        await reactionHandler.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(mockPendingUpdate.upvoters.size).toBe(1);
        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(1); // Attempted
        expect(messageUtilsEditMock).toHaveBeenCalledTimes(1); // Fallback attempted and succeeded
        
        const updatedEmbedForMessage = messageUtilsEditMock.mock.calls[0][1].embeds[0] as EmbedBuilder;
         expect(updatedEmbedForMessage.setDescription).toHaveBeenCalledWith(
            `React with ${GameConstants.RANK_UPVOTE_EMOJI}. ${GameConstants.RANK_UPVOTES_REQUIRED} needed. Current: 1 / ${GameConstants.RANK_UPVOTES_REQUIRED}`
        );
    });
});