/// <reference types="vitest/globals" />
import {
    MessageReaction,
    Message,
    User,
    EmbedBuilder,
    Locale,
    ChatInputCommandInteraction,
} from 'discord.js';
import { Rating as OpenSkillRating } from 'openskill';
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';

// --- Mocking Section ---

vi.mock('../../src/commands/chat/rank-command.ts', async () => {
    const actual = await vi.importActual('../../src/commands/chat/rank-command.ts');
    return {
        ...actual,
        RankCommand: {
            ...(actual as any).RankCommand,
            pendingRankUpdates: new Map<string, PendingRankUpdate>(),
        },
    };
});

vi.mock('../../src/constants/index.ts', () => ({
    GameConstants: {
        RANK_UPVOTES_REQUIRED: 3,
        RANK_UPVOTE_EMOJI: '👍',
    },
    // If DiscordLimits is needed by other parts, keep it. For this test, it's not directly used.
}));

vi.mock('../../src/db.ts', () => ({
    PlayerRating: {
        upsert: vi.fn(),
    },
}));

vi.mock('../../src/services/lang.ts', () => ({
    Lang: {
        getRef: vi.fn(),
        getEmbed: vi.fn(),
        getRefLocalizationMap: vi.fn().mockReturnValue({}),
    },
}));

vi.mock('../../src/utils/interaction-utils.ts', () => ({
    InteractionUtils: {
        editReply: vi.fn(),
        send: vi.fn(),
    },
}));

vi.mock('../../src/utils/message-utils.ts', () => ({
    MessageUtils: {
        clearReactions: vi.fn(),
        edit: vi.fn(),
    },
}));

vi.mock('../../src/utils/rating-utils.ts', () => ({
    RatingUtils: {
        calculateElo: vi.fn((mu, sigma) => Math.round((mu - 3 * sigma + 20) * 58.33)),
    },
}));

vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');
    const MockedEmbedBuilder = vi.fn().mockImplementation((initialData?: any) => {
        let _data: any = initialData
            ? { ...initialData }
            : { title: '', description: '', fields: [] };
        if (initialData && typeof initialData.toJSON === 'function') {
            // If it's an Embed-like object with toJSON
            _data = { ...initialData.toJSON() };
        }
        if (!_data.fields) _data.fields = [];

        const builderInstance = {
            setTitle: vi.fn(function (title: string) {
                _data.title = title;
                return this;
            }),
            addFields: vi.fn(function (...fields: any[]) {
                const newFields = fields.flat();
                _data.fields.push(...newFields);
                return this;
            }),
            setDescription: vi.fn(function (description: string) {
                _data.description = description;
                return this;
            }),
            setColor: vi.fn().mockReturnThis(),
            setAuthor: vi.fn().mockReturnThis(),
            setFooter: vi.fn().mockReturnThis(),
            setThumbnail: vi.fn().mockReturnThis(),
            setTimestamp: vi.fn().mockReturnThis(),
            setURL: vi.fn().mockReturnThis(),
            setImage: vi.fn().mockReturnThis(),
            spliceFields: vi.fn().mockReturnThis(),
            toJSON: vi.fn(() => ({ ..._data })),
            data: _data, // Expose data for inspection if needed, toJSON is preferred
        };
        return builderInstance;
    });
    return {
        ...actual,
        EmbedBuilder: MockedEmbedBuilder,
        Locale: actual.Locale,
    };
});

import { RankCommand, PendingRankUpdate, ParsedPlayer } from '../../src/commands/chat/rank-command';
import { GameConstants } from '../../src/constants/index';
import { PlayerRating } from '../../src/db';
import { EventData } from '../../src/models/internal-models';
import { RankConfirmationReaction } from '../../src/reactions/rank-confirmation-reaction';
import { Lang } from '../../src/services/lang';
import { InteractionUtils, MessageUtils, RatingUtils } from '../../src/utils/index';

// --- Test Suite ---
describe('RankConfirmationReaction', () => {
    let reactionInstance: RankConfirmationReaction;
    let mockMsgReaction: MessageReaction;
    let mockMsg: Message;
    let mockReactor: User;
    let mockEventData: EventData;
    let mockPendingUpdate: PendingRankUpdate;
    let mockInteraction: ChatInputCommandInteraction;

    let langGetRefMock: MockedFunction<typeof Lang.getRef>;
    let langGetEmbedMock: MockedFunction<typeof Lang.getEmbed>;
    let interactionUtilsEditReplyMock: MockedFunction<typeof InteractionUtils.editReply>;
    let interactionUtilsSendMock: MockedFunction<typeof InteractionUtils.send>;
    let messageUtilsClearReactionsMock: MockedFunction<typeof MessageUtils.clearReactions>;
    let messageUtilsEditMock: MockedFunction<typeof MessageUtils.edit>;
    let playerRatingUpsertMock: MockedFunction<typeof PlayerRating.upsert>;
    let ratingUtilsCalculateEloMock: MockedFunction<typeof RatingUtils.calculateElo>;

    const MOCK_MESSAGE_ID = 'message123';
    const MOCK_GUILD_ID = 'guild456';
    const REACTOR_ID = 'reactor789';

    const player1InitialRating: OpenSkillRating = { mu: 25, sigma: 8.33 };
    const player1NewRating: OpenSkillRating = { mu: 28, sigma: 7.5 };
    const player2InitialRating: OpenSkillRating = { mu: 22, sigma: 7 };
    const player2NewRating: OpenSkillRating = { mu: 19, sigma: 6.5 };

    let parsedPlayer1: ParsedPlayer;
    let parsedPlayer2: ParsedPlayer;

    beforeEach(async () => {
        reactionInstance = new RankConfirmationReaction();
        RankCommand.pendingRankUpdates.clear(); // Clear at the beginning

        // --- Dynamic Imports for Mocking ---
        const DiscordJS = vi.mocked(await import('discord.js'));
        const { RankCommand: MockedRankCommandModule } = await import(
            '../../src/commands/chat/rank-command'
        );
        const { Lang: MockLangModule } = await import('../../src/services/lang');
        const { InteractionUtils: MockInteractionUtilsModule } = await import(
            '../../src/utils/interaction-utils'
        );
        const { MessageUtils: MockMessageUtilsModule } = await import(
            '../../src/utils/message-utils'
        );
        const { PlayerRating: MockPlayerRatingModule } = await import('../../src/db');
        const { RatingUtils: MockRatingUtilsModule } = await import('../../src/utils/rating-utils');

        // --- Assign Mocks from Imported Modules ---
        // Note: `as any` is used because RankCommand.pendingRankUpdates is static and readonly
        (RankCommand.pendingRankUpdates as any) = (
            MockedRankCommandModule as any
        ).pendingRankUpdates;
        RankCommand.pendingRankUpdates.clear(); // Ensure it's cleared again if the above re-assigns it.

        langGetRefMock = vi.mocked(MockLangModule.getRef);
        langGetEmbedMock = vi.mocked(MockLangModule.getEmbed);
        interactionUtilsEditReplyMock = vi.mocked(MockInteractionUtilsModule.editReply);
        interactionUtilsSendMock = vi.mocked(MockInteractionUtilsModule.send);
        messageUtilsClearReactionsMock = vi.mocked(MockMessageUtilsModule.clearReactions);
        messageUtilsEditMock = vi.mocked(MockMessageUtilsModule.edit);
        playerRatingUpsertMock = vi.mocked(MockPlayerRatingModule.upsert);
        ratingUtilsCalculateEloMock = vi.mocked(MockRatingUtilsModule.calculateElo);

        // --- Mock Implementations ---
        langGetEmbedMock.mockImplementation(() => new DiscordJS.EmbedBuilder() as any);
        langGetRefMock.mockImplementation((key: string, _lang?: Locale, vars?: any): string => {
            if (key === 'fields.provisionalRatings') return 'Provisional Ratings';
            if (key === 'fields.confirmedRatings') return 'Confirmed Ratings';
            if (key === 'terms.winner') return 'Winner';
            if (key === 'terms.loser') return 'Loser';
            if (key === 'rankMessages.updateProvisionalDesc' && vars) {
                return `React with ${vars.UPVOTE_EMOJI}. ${vars.UPVOTES_REQUIRED} unique reactions are needed.\\Current upvotes: ${vars.CURRENT_UPVOTES} / ${vars.UPVOTES_REQUIRED}`;
            }
            // Add other keys if Lang.getRef is called with them during tests
            if (key === 'displayEmbeds.rankConfirmed') return 'displayEmbeds.rankConfirmed'; // Placeholder for getEmbed
            if (key === 'errorEmbeds.rankUpdateFailed') return 'errorEmbeds.rankUpdateFailed'; // Placeholder for getEmbed
            return key;
        });

        ratingUtilsCalculateEloMock.mockImplementation((mu, sigma) =>
            Math.round((mu - 3 * sigma + 20) * 58.33)
        );

        playerRatingUpsertMock.mockResolvedValue([{} as any, true]); // Default success
        interactionUtilsEditReplyMock.mockResolvedValue({} as Message); // Default success
        interactionUtilsSendMock.mockResolvedValue({} as Message); // Default success
        messageUtilsClearReactionsMock.mockResolvedValue(undefined); // Default success
        messageUtilsEditMock.mockResolvedValue({} as Message); // Default success

        // --- Initialize Parsed Players (dependent on ratingUtilsCalculateEloMock) ---
        parsedPlayer1 = {
            userId: 'player1Id',
            status: 'w',
            tag: 'Player1#0001',
            initialRating: player1InitialRating,
            initialElo: ratingUtilsCalculateEloMock(
                player1InitialRating.mu,
                player1InitialRating.sigma
            ),
            initialWins: 1,
            initialLosses: 0,
            newRating: player1NewRating,
            newWins: 2,
            newLosses: 0,
        };
        parsedPlayer2 = {
            userId: 'player2Id',
            status: 'l',
            tag: 'Player2#0002',
            initialRating: player2InitialRating,
            initialElo: ratingUtilsCalculateEloMock(
                player2InitialRating.mu,
                player2InitialRating.sigma
            ),
            initialWins: 0,
            initialLosses: 1,
            newRating: player2NewRating,
            newWins: 0,
            newLosses: 2,
        };

        // --- Initialize Test-Specific Mock Data ---
        mockReactor = { id: REACTOR_ID, bot: false, tag: 'Reactor#0001' } as User;
        const initialApiEmbed = {
            title: 'Initial Title',
            description: 'Initial Description',
            fields: [],
        };
        mockMsg = {
            id: MOCK_MESSAGE_ID,
            guild: { id: MOCK_GUILD_ID },
            client: { user: { id: 'botId' } },
            embeds: [{ ...initialApiEmbed, toJSON: () => initialApiEmbed } as any],
        } as unknown as Message;

        mockMsgReaction = {
            emoji: { name: GameConstants.RANK_UPVOTE_EMOJI },
            message: mockMsg,
            client: mockMsg.client,
        } as MessageReaction;
        mockEventData = new EventData(Locale.EnglishUS, Locale.EnglishUS);
        mockInteraction = {
            editReply: vi.fn(), // This specific instance can be spied on if needed by tests
            followUp: vi.fn(),
            channel: { type: 0 },
        } as unknown as ChatInputCommandInteraction;

        mockPendingUpdate = {
            guildId: MOCK_GUILD_ID,
            playersToUpdate: [parsedPlayer1, parsedPlayer2],
            interaction: mockInteraction,
            lang: Locale.EnglishUS,
            upvoters: new Set<string>(),
            status: 'active', // Add the status property
        };
    });

    afterEach(() => {
        vi.clearAllMocks(); // Clears spy history and mock implementations, but doesn't un-mock the module
    });

    it('should have correct static properties', () => {
        expect(reactionInstance.emoji).toBe(GameConstants.RANK_UPVOTE_EMOJI);
        expect(reactionInstance.requireGuild).toBe(true);
        expect(reactionInstance.requireSentByClient).toBe(true);
        expect(reactionInstance.requireEmbedAuthorTag).toBe(false);
    });

    it('should do nothing if pendingUpdate is not found for the messageId', async () => {
        await reactionInstance.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);
        expect(mockPendingUpdate.upvoters.size).toBe(0);
        expect(playerRatingUpsertMock).not.toHaveBeenCalled();
        expect(interactionUtilsEditReplyMock).not.toHaveBeenCalled();
    });

    it('should do nothing if reactor has already upvoted', async () => {
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, mockPendingUpdate);
        mockPendingUpdate.upvoters.add(REACTOR_ID);

        await reactionInstance.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(mockPendingUpdate.upvoters.size).toBe(1);
        expect(playerRatingUpsertMock).not.toHaveBeenCalled();
    });

    it('should increment upvotes and update provisional embed if threshold is not met', async () => {
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, mockPendingUpdate);

        await reactionInstance.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(mockPendingUpdate.upvoters.has(REACTOR_ID)).toBe(true);
        expect(mockPendingUpdate.upvoters.size).toBe(1);
        expect(playerRatingUpsertMock).not.toHaveBeenCalled();
        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(1);
        const editedEmbed = interactionUtilsEditReplyMock.mock.calls[0][1] as EmbedBuilder;
        expect(editedEmbed.setDescription).toHaveBeenCalledWith(
            `React with ${GameConstants.RANK_UPVOTE_EMOJI}. ${GameConstants.RANK_UPVOTES_REQUIRED} unique reactions are needed.\\Current upvotes: 1 / ${GameConstants.RANK_UPVOTES_REQUIRED}`
        );
    });

    it('should finalize rank update if upvote threshold is met', async () => {
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, mockPendingUpdate);
        mockPendingUpdate.upvoters.add('userA');
        mockPendingUpdate.upvoters.add('userB');

        await reactionInstance.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(mockPendingUpdate.upvoters.has(REACTOR_ID)).toBe(true);
        expect(mockPendingUpdate.upvoters.size).toBe(GameConstants.RANK_UPVOTES_REQUIRED);

        expect(playerRatingUpsertMock).toHaveBeenCalledTimes(
            mockPendingUpdate.playersToUpdate.length
        );
        expect(playerRatingUpsertMock).toHaveBeenCalledWith({
            userId: parsedPlayer1.userId,
            guildId: MOCK_GUILD_ID,
            mu: parsedPlayer1.newRating.mu,
            sigma: parsedPlayer1.newRating.sigma,
            wins: parsedPlayer1.newWins,
            losses: parsedPlayer1.newLosses,
        });

        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(1);
        const finalEmbed = interactionUtilsEditReplyMock.mock.calls[0][1] as EmbedBuilder;
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.rankConfirmed',
            mockPendingUpdate.lang
        );
        expect(finalEmbed.setTitle).toHaveBeenCalledWith('Confirmed Ratings');
        expect(finalEmbed.addFields).toHaveBeenCalledTimes(
            mockPendingUpdate.playersToUpdate.length
        );
        const elo1 = ratingUtilsCalculateEloMock(
            parsedPlayer1.newRating.mu,
            parsedPlayer1.newRating.sigma
        );
        expect(finalEmbed.addFields).toHaveBeenCalledWith(
            expect.objectContaining({
                name: `${parsedPlayer1.tag} (Winner)`,
                value: `Old: Elo=${parsedPlayer1.initialElo}, μ=${parsedPlayer1.initialRating.mu.toFixed(2)}, σ=${parsedPlayer1.initialRating.sigma.toFixed(2)}, W/L: ${parsedPlayer1.initialWins}/${parsedPlayer1.initialLosses}\nNew: Elo=${elo1}, μ=${parsedPlayer1.newRating.mu.toFixed(2)}, σ=${parsedPlayer1.newRating.sigma.toFixed(2)}, W/L: ${parsedPlayer1.newWins}/${parsedPlayer1.newLosses}`,
            })
        );

        expect(RankCommand.pendingRankUpdates.has(MOCK_MESSAGE_ID)).toBe(false);
        expect(messageUtilsClearReactionsMock).toHaveBeenCalledWith(mockMsg);
    });

    it('should handle error during PlayerRating.upsert, inform user, and remove pending update', async () => {
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, mockPendingUpdate);
        mockPendingUpdate.upvoters.add('userA');
        mockPendingUpdate.upvoters.add('userB');
        playerRatingUpsertMock.mockRejectedValueOnce(new Error('DB upsert failed'));

        await reactionInstance.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(playerRatingUpsertMock).toHaveBeenCalledTimes(1);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'errorEmbeds.rankUpdateFailed',
            mockPendingUpdate.lang
        );
        expect(interactionUtilsEditReplyMock).toHaveBeenCalledWith(
            mockPendingUpdate.interaction,
            expect.any(Object) // Changed from EmbedBuilder
        );
        expect(RankCommand.pendingRankUpdates.has(MOCK_MESSAGE_ID)).toBe(false);
    });

    it('should handle error editing original interaction (finalizing) and try sending new message as fallback', async () => {
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, mockPendingUpdate);
        mockPendingUpdate.upvoters.add('userA');
        mockPendingUpdate.upvoters.add('userB');
        // Mock the first call to editReply (for confirmedEmbed) to fail
        interactionUtilsEditReplyMock.mockRejectedValueOnce(new Error('Original edit failed'));
        // Mock the second call to editReply (for errorEmbed) to also fail, triggering the send fallback
        interactionUtilsEditReplyMock.mockRejectedValueOnce(
            new Error('Error embed edit also failed')
        );

        await reactionInstance.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(playerRatingUpsertMock).toHaveBeenCalledTimes(
            mockPendingUpdate.playersToUpdate.length
        ); // Ensure upsert still happens

        // Check that Lang.getEmbed was called for the error message
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'errorEmbeds.rankUpdateFailed',
            mockPendingUpdate.lang
        );

        // editReply should have been called twice (once for confirmed, once for error embed - both failed)
        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(2);

        // The first call to editReply (should be for the confirmed embed)
        expect(interactionUtilsEditReplyMock).toHaveBeenNthCalledWith(
            1,
            mockPendingUpdate.interaction,
            expect.objectContaining({
                data: expect.objectContaining({ title: 'Confirmed Ratings' }),
            })
        );
        // The second call to editReply (should be for the error embed)
        expect(interactionUtilsEditReplyMock).toHaveBeenNthCalledWith(
            2,
            mockPendingUpdate.interaction,
            expect.any(Object) // The error embed from Lang.getEmbed
        );

        // send should have been called once as a fallback
        expect(interactionUtilsSendMock).toHaveBeenCalledTimes(1);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(
            mockPendingUpdate.interaction,
            expect.any(Object), // The error embed
            true
        );
        expect(RankCommand.pendingRankUpdates.has(MOCK_MESSAGE_ID)).toBe(false);
    });

    it('should handle error editing provisional embed via interaction and try editing message directly as fallback', async () => {
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, mockPendingUpdate);
        interactionUtilsEditReplyMock.mockRejectedValueOnce(new Error('Interaction edit failed'));

        await reactionInstance.execute(mockMsgReaction, mockMsg, mockReactor, mockEventData);

        expect(interactionUtilsEditReplyMock).toHaveBeenCalledTimes(1);
        expect(messageUtilsEditMock).toHaveBeenCalledTimes(1);
        const editedEmbedViaMessage = messageUtilsEditMock.mock.calls[0][1] as {
            embeds: EmbedBuilder[];
        };
        expect(editedEmbedViaMessage.embeds[0].setDescription).toHaveBeenCalledWith(
            `React with ${GameConstants.RANK_UPVOTE_EMOJI}. ${GameConstants.RANK_UPVOTES_REQUIRED} unique reactions are needed.\\Current upvotes: 1 / ${GameConstants.RANK_UPVOTES_REQUIRED}`
        );
    });
});
