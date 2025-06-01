/// <reference types="vitest/globals" />
import {
    ChatInputCommandInteraction,
    EmbedBuilder,
    Locale,
    CacheType,
    User,
    Message,
    TextBasedChannel,
    GuildTextBasedChannel,
} from 'discord.js';
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';

import {
    RankCommand,
    PendingRankUpdate,
    ParsedPlayer,
    LatestPendingRankContext,
    LatestConfirmedRankOpDetails,
} from '../../../src/commands/chat/rank-command.js';
import { UndoCommand } from '../../../src/commands/chat/undo-command.js';
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
            getCom: vi.fn(key => {
                if (key === 'colors.grey') return '0x808080'; // Hex for grey
                if (key === 'colors.warning') return '0xFFEE00'; // Example hex for warning
                return key;
            }),
            getRefLocalizationMap: vi.fn(() => ({})),
        },
    };
});

vi.mock('../../../src/utils/interaction-utils.js', () => ({
    InteractionUtils: {
        send: vi.fn(),
        editReply: vi.fn(),
    },
}));

vi.mock('../../../src/utils/message-utils.js', () => ({
    MessageUtils: {
        edit: vi.fn(),
        clearReactions: vi.fn(),
    },
}));

vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');
    const MockedEmbedBuilder = vi.fn(initialData => {
        let _data = initialData ? { ...initialData } : { title: '', description: '', fields: [] };
        if (initialData && typeof initialData.toJSON === 'function') {
            _data = { ...initialData.toJSON() };
        }
        if (!_data.fields) _data.fields = [];

        const builderInstance = {
            setTitle: vi.fn(function (title) {
                _data.title = title;
                return this;
            }),
            setDescription: vi.fn(function (description) {
                _data.description = description;
                return this;
            }),
            addFields: vi.fn(function (...fields) {
                const newFields = fields
                    .flat()
                    .map(f => ({ name: f.name, value: f.value, inline: !!f.inline }));
                if (!_data.fields) _data.fields = [];
                _data.fields.push(...newFields);
                return this;
            }),
            setColor: vi.fn(function (color) {
                _data.color = color;
                return this;
            }), // Store color
            toJSON: vi.fn(() => ({ ..._data })),
            get data() {
                return _data;
            }, // Use a getter for data
        };
        return builderInstance;
    });
    return {
        ...actual,
        EmbedBuilder: MockedEmbedBuilder,
        Locale: actual.Locale,
    };
});

// --- Test Suite ---
describe('UndoCommand', () => {
    let undoCommand: UndoCommand;
    let mockIntr: ChatInputCommandInteraction<CacheType>;
    let mockEventData: EventData;
    const MOCK_GUILD_ID = 'testGuildId123';
    const MOCK_MESSAGE_ID = 'messageId456';
    const MOCK_CHANNEL_ID = 'channelId789';

    let langGetRefMock: MockedFunction<any>;
    let langGetEmbedMock: MockedFunction<any>;
    let interactionUtilsSendMock: MockedFunction<any>;
    let interactionUtilsEditReplyMock: MockedFunction<any>;
    let messageUtilsEditMock: MockedFunction<any>;
    let messageUtilsClearReactionsMock: MockedFunction<any>;
    let playerRatingUpsertMock: MockedFunction<typeof PlayerRating.upsert>;
    // let currentMockEmbed: EmbedBuilder; // No longer needed as a shared instance

    const player1: ParsedPlayer = {
        userId: 'p1',
        tag: 'PlayerOne#1111',
        status: 'w',
        initialRating: { mu: 25, sigma: 8 },
        initialElo: 1225,
        initialWins: 0,
        initialLosses: 0,
        newRating: { mu: 28, sigma: 7 },
        newWins: 1,
        newLosses: 0,
    };
    const player2: ParsedPlayer = {
        userId: 'p2',
        tag: 'PlayerTwo#2222',
        status: 'l',
        initialRating: { mu: 20, sigma: 5 },
        initialElo: 1167,
        initialWins: 5,
        initialLosses: 2,
        newRating: { mu: 18, sigma: 4.8 },
        newWins: 5,
        newLosses: 3,
    };

    beforeEach(async () => {
        undoCommand = new UndoCommand();
        RankCommand.pendingRankUpdates.clear();
        RankCommand.latestPendingRankContext = null;
        RankCommand.latestConfirmedRankOpDetails = null;

        const { PlayerRating: MockedPlayerRating } = await import('../../../src/db.js');
        playerRatingUpsertMock = MockedPlayerRating.upsert as MockedFunction<
            typeof PlayerRating.upsert
        >;

        const { Lang } = await import('../../../src/services/lang.js');
        langGetRefMock = Lang.getRef as MockedFunction<any>;
        langGetEmbedMock = Lang.getEmbed as MockedFunction<any>;

        const { InteractionUtils } = await import('../../../src/utils/interaction-utils.js');
        interactionUtilsSendMock = InteractionUtils.send as MockedFunction<any>;
        interactionUtilsEditReplyMock = InteractionUtils.editReply as MockedFunction<any>;

        const { MessageUtils } = await import('../../../src/utils/message-utils.js');
        messageUtilsEditMock = MessageUtils.edit as MockedFunction<any>;
        messageUtilsClearReactionsMock = MessageUtils.clearReactions as MockedFunction<any>;

        // Ensure Lang.getEmbed returns a new mock EmbedBuilder instance each time
        langGetEmbedMock.mockImplementation(() => new EmbedBuilder());

        mockEventData = new EventData(Locale.EnglishUS, Locale.EnglishUS);
        mockIntr = {
            guild: { id: MOCK_GUILD_ID },
            user: { id: 'undoUser' } as User,
            client: {
                channels: {
                    fetch: vi.fn().mockImplementation(async id => {
                        if (id === MOCK_CHANNEL_ID) {
                            // Make sure the embed in the fetched message is also a mocked EmbedBuilder instance
                            const mockMessageEmbed = new EmbedBuilder().setTitle('Original Rank');
                            return {
                                isTextBased: () => true,
                                messages: {
                                    fetch: vi.fn().mockResolvedValue({
                                        id: MOCK_MESSAGE_ID,
                                        embeds: [mockMessageEmbed.toJSON()], // Use toJSON() from the mocked EmbedBuilder
                                    } as Message),
                                },
                            } as unknown as GuildTextBasedChannel;
                        }
                        return null;
                    }),
                },
            },
            channelId: 'intrChannel',
            isChatInputCommand: () => true,
        } as unknown as ChatInputCommandInteraction<CacheType>;

        langGetRefMock.mockImplementation((key: any, _locale?: any, vars?: any) => {
            switch (key) {
                case 'fields.undoConfirmedTitle':
                    return 'Undo Confirmed Title';
                case 'undoMessages.confirmedDescriptionText':
                    return 'The last confirmed rank operation has been undone. Player ratings and stats have been reverted.';
                case 'undoMessages.playerChangeFormat':
                    return `Old: Elo=${vars.OLD_ELO}, μ=${vars.OLD_MU}, σ=${vars.OLD_SIGMA}, W/L: ${vars.OLD_WINS}/${vars.OLD_LOSSES}\\nNew (Reverted): Elo=${vars.NEW_ELO}, μ=${vars.NEW_MU}, σ=${vars.NEW_SIGMA}, W/L: ${vars.NEW_WINS}/${vars.NEW_LOSSES}`;
                case 'fields.rankUndoneTitle':
                    return 'Rank Operation Undone';
                case 'undoMessages.rankUndoneText':
                    return 'This rank operation was undone by the /undo command.';
                case 'fields.rankDisabledTitle':
                    return 'Pending Rank Disabled (Undo)';
                case 'undoMessages.rankDisabledDescriptionText':
                    return `This pending rank update has been **disabled** by an /undo command. It will not be processed. Upvoting with ${vars.UPVOTE_EMOJI} will have no effect.`;
                default:
                    return key;
            }
        });
        playerRatingUpsertMock.mockResolvedValue([{} as any, true]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should send "guild only" error if command is used outside a guild', async () => {
        const intrNoGuild = { ...mockIntr, guild: null } as ChatInputCommandInteraction;
        let capturedErrorEmbed: EmbedBuilder | undefined;
        langGetEmbedMock.mockImplementationOnce(() => {
            const embed = new EmbedBuilder();
            capturedErrorEmbed = embed;
            return embed;
        });

        await undoCommand.execute(intrNoGuild, mockEventData);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'errorEmbeds.commandNotInGuild',
            mockEventData.lang
        );
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(
            intrNoGuild,
            capturedErrorEmbed,
            true
        );
    });

    it('should undo a confirmed rank operation', async () => {
        let capturedUndoEmbed: EmbedBuilder | undefined;
        let capturedMessageEditEmbed: EmbedBuilder | undefined;

        // Mock for the main undo confirmation embed
        langGetEmbedMock.mockImplementationOnce(() => {
            const embed = new EmbedBuilder();
            capturedUndoEmbed = embed;
            return embed;
        });

        // For the embed created via new EmbedBuilder(originalMessage.embeds[0]?.toJSON())
        // The global mock of EmbedBuilder will handle this, but we can't easily capture
        // its instance this way without more complex mocking. We'll rely on asserting
        // the call to messageUtilsEditMock with an EmbedBuilder.

        RankCommand.latestConfirmedRankOpDetails = {
            guildId: MOCK_GUILD_ID,
            messageId: MOCK_MESSAGE_ID,
            channelId: MOCK_CHANNEL_ID,
            players: [player1, player2],
            timestamp: Date.now(),
        };

        await undoCommand.execute(mockIntr, mockEventData);

        expect(playerRatingUpsertMock).toHaveBeenCalledTimes(2);
        expect(playerRatingUpsertMock).toHaveBeenCalledWith({
            userId: player1.userId,
            guildId: MOCK_GUILD_ID,
            mu: player1.initialRating.mu,
            sigma: player1.initialRating.sigma,
            wins: player1.initialWins,
            losses: player1.initialLosses,
        });
        expect(playerRatingUpsertMock).toHaveBeenCalledWith({
            userId: player2.userId,
            guildId: MOCK_GUILD_ID,
            mu: player2.initialRating.mu,
            sigma: player2.initialRating.sigma,
            wins: player2.initialWins,
            losses: player2.initialLosses,
        });

        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.undoConfirmedTitle',
            mockEventData.lang
        );

        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, capturedUndoEmbed);
        expect(capturedUndoEmbed).toBeDefined();
        if (capturedUndoEmbed) {
            expect(capturedUndoEmbed.setTitle).toHaveBeenCalledWith('Undo Confirmed Title');
            expect(capturedUndoEmbed.setDescription).toHaveBeenCalledWith(
                'The last confirmed rank operation has been undone. Player ratings and stats have been reverted.'
            );
            expect(capturedUndoEmbed.addFields).toHaveBeenCalledTimes(2);
            expect(capturedUndoEmbed.addFields).toHaveBeenCalledWith(
                expect.objectContaining({ name: player1.tag })
            );
        }

        expect(mockIntr.client.channels.fetch).toHaveBeenCalledWith(MOCK_CHANNEL_ID);

        // Asserting the edited message's embed content
        expect(messageUtilsEditMock).toHaveBeenCalledTimes(1);
        const editCallArgs = messageUtilsEditMock.mock.calls[0];

        // Check the first argument (originalMessage)
        expect(editCallArgs[0]).toMatchObject({ id: MOCK_MESSAGE_ID });

        // Check the second argument (options object)
        const editedMessageOptions = editCallArgs[1] as { embeds: any[] };
        expect(editedMessageOptions.embeds).toHaveLength(1);
        // Access the toJSON() method of the mocked EmbedBuilder instance
        expect(editedMessageOptions.embeds[0].toJSON()).toMatchObject({
            title: 'Rank Operation Undone',
            description: 'This rank operation was undone by the /undo command.',
            color: '0xFFEE00', // From Lang.getCom('colors.warning')
            fields: [], // Expect an empty array for fields in this specific embed
        });

        expect(messageUtilsClearReactionsMock).toHaveBeenCalled();
        expect(RankCommand.latestConfirmedRankOpDetails).toBeNull();
    });

    it('should disable a pending rank operation', async () => {
        const mockPendingInteraction = {
            fetchReply: vi.fn().mockResolvedValue({
                id: MOCK_MESSAGE_ID,
                // Ensure the embed here is also from a mocked EmbedBuilder for consistency
                embeds: [new EmbedBuilder().setTitle('Pending Rank').toJSON()],
            } as Message),
            guild: { id: MOCK_GUILD_ID }, // Add guild for consistency if undo logic might access it from interaction
            user: { id: 'pendingUser' } as User,
            client: mockIntr.client, // Share client mock
        } as unknown as ChatInputCommandInteraction<CacheType>;

        RankCommand.latestPendingRankContext = {
            guildId: MOCK_GUILD_ID,
            messageId: MOCK_MESSAGE_ID,
            channelId: MOCK_CHANNEL_ID,
            interaction: mockPendingInteraction,
        };
        const pendingUpdate: PendingRankUpdate = {
            guildId: MOCK_GUILD_ID,
            playersToUpdate: [player1, player2],
            interaction: mockPendingInteraction,
            lang: mockEventData.lang,
            upvoters: new Set(),
            status: 'active',
        };
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, pendingUpdate);

        await undoCommand.execute(mockIntr, mockEventData);

        expect(pendingUpdate.status).toBe('disabled_by_undo');
        expect(RankCommand.pendingRankUpdates.get(MOCK_MESSAGE_ID)?.status).toBe(
            'disabled_by_undo'
        );

        expect(interactionUtilsEditReplyMock).toHaveBeenCalledWith(
            mockPendingInteraction,
            expect.any(Object)
        ); // Check for any object representing an embed

        const editReplyCallArgs = interactionUtilsEditReplyMock.mock.calls[0]; // Get the first call
        expect(editReplyCallArgs).toBeDefined();
        const disabledEmbed = editReplyCallArgs[1] as EmbedBuilder; // Cast to EmbedBuilder for method checks

        expect(disabledEmbed.setTitle).toHaveBeenCalledWith('Pending Rank Disabled (Undo)');
        expect(disabledEmbed.setDescription).toHaveBeenCalledWith(
            `This pending rank update has been **disabled** by an /undo command. It will not be processed. Upvoting with ${GameConstants.RANK_UPVOTE_EMOJI} will have no effect.`
        );
        expect(disabledEmbed.setColor).toHaveBeenCalledWith(0x808080); // Grey

        expect(messageUtilsClearReactionsMock).toHaveBeenCalled();

        // Check the success message sent to mockIntr (the interaction that called /undo)
        // This happens within the same execute call. We need to find the correct send call.
        const successSendCall = interactionUtilsSendMock.mock.calls.find(
            call => call[0] === mockIntr
        );
        expect(successSendCall).toBeDefined();
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.undoPendingSuccess',
            mockEventData.lang
        );
        // If capturedSuccessEmbed was set up to be returned by langGetEmbedMock for this key:
        // expect(successSendCall[1]).toBe(capturedSuccessEmbed);
        expect(successSendCall[1]).toEqual(expect.objectContaining({ data: expect.any(Object) }));

        expect(RankCommand.latestPendingRankContext).toBeNull();
    });

    it('should inform if pending rank is already disabled', async () => {
        RankCommand.latestPendingRankContext = {
            guildId: MOCK_GUILD_ID,
            messageId: MOCK_MESSAGE_ID,
            channelId: MOCK_CHANNEL_ID,
            interaction: {
                guild: { id: MOCK_GUILD_ID },
                user: { id: 'pendingUser' } as User,
                client: mockIntr.client,
            } as ChatInputCommandInteraction,
        };
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, {
            status: 'disabled_by_undo',
        } as PendingRankUpdate);

        await undoCommand.execute(mockIntr, mockEventData);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.undoAlreadyDisabled',
            mockEventData.lang
        );

        const alreadyDisabledSendCallArgs = interactionUtilsSendMock.mock.calls.find(
            call => call[0] === mockIntr
        );
        expect(alreadyDisabledSendCallArgs).toBeDefined();
        expect(alreadyDisabledSendCallArgs[1]).toEqual(
            expect.objectContaining({ data: expect.any(Object) })
        );
        expect(alreadyDisabledSendCallArgs[2]).toBe(true);
    });

    it('should inform if there is nothing to undo', async () => {
        await undoCommand.execute(mockIntr, mockEventData);
        expect(langGetEmbedMock).toHaveBeenCalledWith(
            'displayEmbeds.undoNothingToUndo',
            mockEventData.lang
        );

        const nothingSendCallArgs = interactionUtilsSendMock.mock.calls.find(
            call => call[0] === mockIntr
        );
        expect(nothingSendCallArgs).toBeDefined();
        expect(nothingSendCallArgs[1]).toEqual(
            expect.objectContaining({ data: expect.any(Object) })
        );
        expect(nothingSendCallArgs[2]).toBe(true);
    });

    it('should handle failure to revert confirmed rank gracefully', async () => {
        RankCommand.latestConfirmedRankOpDetails = {
            guildId: MOCK_GUILD_ID,
            messageId: MOCK_MESSAGE_ID,
            channelId: MOCK_CHANNEL_ID,
            players: [player1],
            timestamp: Date.now(),
        };
        playerRatingUpsertMock.mockRejectedValueOnce(new Error('DB Error'));

        await undoCommand.execute(mockIntr, mockEventData);

        expect(langGetEmbedMock).toHaveBeenCalledWith('errorEmbeds.undoFailed', mockEventData.lang);

        const errorSendCallArgs = interactionUtilsSendMock.mock.calls.find(
            call => call[0] === mockIntr
        );
        expect(errorSendCallArgs).toBeDefined();
        expect(errorSendCallArgs[1]).toEqual(
            expect.objectContaining({ data: expect.any(Object) })
        );
        expect(errorSendCallArgs[2]).toBe(true);

        // latestConfirmedRankOpDetails should still be set to allow retry or manual check
        expect(RankCommand.latestConfirmedRankOpDetails).not.toBeNull();
    });

    it('should handle failure to disable pending rank, reverting status and informing user', async () => {
        const mockPendingInteraction = {
            fetchReply: vi.fn().mockRejectedValue(new Error('Fetch reply failed')), // Make edit fail
            guild: { id: MOCK_GUILD_ID },
            user: { id: 'pendingUser' } as User,
            client: mockIntr.client,
        } as unknown as ChatInputCommandInteraction<CacheType>;
        RankCommand.latestPendingRankContext = {
            guildId: MOCK_GUILD_ID,
            messageId: MOCK_MESSAGE_ID,
            channelId: MOCK_CHANNEL_ID,
            interaction: mockPendingInteraction,
        };
        const pendingUpdate: PendingRankUpdate = {
            guildId: MOCK_GUILD_ID,
            playersToUpdate: [],
            interaction: mockPendingInteraction,
            lang: mockEventData.lang,
            upvoters: new Set(),
            status: 'active',
        };
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, pendingUpdate);

        await undoCommand.execute(mockIntr, mockEventData);

        expect(pendingUpdate.status).toBe('active'); // Should be reverted
        expect(langGetEmbedMock).toHaveBeenCalledWith('errorEmbeds.undoFailed', mockEventData.lang);

        const errorSendCall = interactionUtilsSendMock.mock.calls.find(
            call => call[0] === mockIntr
        );
        expect(errorSendCall).toBeDefined();
        expect(errorSendCall[1]).toEqual(expect.objectContaining({ data: expect.any(Object) }));
        expect(errorSendCall[2]).toBe(true);

        // latestPendingRankContext should still be set to allow retry or manual check
        expect(RankCommand.latestPendingRankContext).not.toBeNull();
    });
});
