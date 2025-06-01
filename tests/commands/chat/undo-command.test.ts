/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
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

import { UndoCommand } from '../../../src/commands/chat/undo-command.js';
import {
    RankCommand,
    PendingRankUpdate,
    ParsedPlayer,
    LatestPendingRankContext,
    LatestConfirmedRankOpDetails,
} from '../../../src/commands/chat/rank-command.js';
import type {
    PlayerRatingModelStatic,
    PlayerRatingInstance,
} from '../../../src/models/db/player-rating.js';
import { PlayerRating } from '../../../src/db.js';
import { EventData } from '../../../src/models/internal-models.js';
import { RatingUtils } from '../../../src/utils/rating-utils.js';
import { GameConstants } from '../../../src/constants/index.js';

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
            setTitle: vi.fn(function (title) { _data.title = title; return this; }),
            setDescription: vi.fn(function (description) { _data.description = description; return this; }),
            addFields: vi.fn(function (...fields) { 
                const newFields = fields.flat().map(f => ({ name: f.name, value: f.value, inline: !!f.inline }));
                if (!_data.fields) _data.fields = [];
                _data.fields.push(...newFields); 
                return this; 
            }),
            setColor: vi.fn(function (color) { _data.color = color; return this; }), // Store color
            toJSON: vi.fn(() => ({ ..._data })),
            get data() { return _data; }, // Use a getter for data
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
        newElo: 1575,
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
        newElo: 1137,
        newWins: 5,
        newLosses: 3,
    };

    beforeEach(async () => {
        undoCommand = new UndoCommand();
        RankCommand.pendingRankUpdates.clear();
        RankCommand.latestPendingRankContext = null;
        RankCommand.latestConfirmedRankOpDetails = null;

        const { PlayerRating: MockedPlayerRating } = await import('../../../src/db.js');
        playerRatingUpsertMock = MockedPlayerRating.upsert as MockedFunction<typeof PlayerRating.upsert>;

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
        langGetEmbedMock.mockImplementation(() => new EmbedBuilder() as EmbedBuilder);

        mockEventData = new EventData(Locale.EnglishUS, Locale.EnglishUS);
        mockIntr = {
            guild: { id: MOCK_GUILD_ID },
            user: { id: 'undoUser' } as User,
            client: {
                channels: {
                    fetch: vi.fn().mockImplementation(async id => {
                        if (id === MOCK_CHANNEL_ID) {
                            // Make sure the embed in the fetched message is also a mocked EmbedBuilder instance
                            const mockMessageEmbed = new EmbedBuilder().setTitle("Original Rank");
                            return {
                                isTextBased: () => true,
                                messages: { fetch: vi.fn().mockResolvedValue({
                                    id: MOCK_MESSAGE_ID,
                                    embeds: [mockMessageEmbed.toJSON()], // Use toJSON() from the mocked EmbedBuilder
                                } as Message) },
                            } as unknown as GuildTextBasedChannel;
                        }
                        return null;
                    }),
                },
            },
            channelId: 'intrChannel',
            isChatInputCommand: () => true,
        } as unknown as ChatInputCommandInteraction<CacheType>;

        langGetRefMock.mockImplementation((key: string, _locale?: Locale, vars?: any) => {
            if (key === 'fields.undoConfirmedTitle') return 'Undo Confirmed Title';
            if (key === 'displayEmbeds.undoConfirmedDescription') return 'Undo Confirmed Description';
            if (key === 'displayEmbeds.undoPlayerChange') return `Old: ${vars.OLD_ELO} New: ${vars.NEW_ELO}`;
            if (key === 'fields.rankDisabledTitle') return 'Rank Disabled Title';
            if (key === 'displayEmbeds.rankDisabledByUndoDescription') return 'Rank Disabled Description';
            if (key === 'fields.rankUndoneTitle') return 'Rank Undone Title';
            if (key === 'displayEmbeds.rankUndoneDescription') return 'Rank Undone Description';
            return key;
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
            const embed = new EmbedBuilder() as EmbedBuilder;
            capturedErrorEmbed = embed;
            return embed;
        });

        await undoCommand.execute(intrNoGuild, mockEventData);
        expect(langGetEmbedMock).toHaveBeenCalledWith('errorEmbeds.commandNotInGuild', mockEventData.lang);
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(intrNoGuild, capturedErrorEmbed, true);
    });

    it('should undo a confirmed rank operation', async () => {
        let capturedUndoEmbed: EmbedBuilder | undefined;
        let capturedMessageEditEmbed: EmbedBuilder | undefined;

        // Mock for the main undo confirmation embed
        langGetEmbedMock.mockImplementationOnce(() => {
            const embed = new EmbedBuilder() as EmbedBuilder;
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

        expect(langGetEmbedMock).toHaveBeenCalledWith('displayEmbeds.undoConfirmedTitle', mockEventData.lang);
        
        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, capturedUndoEmbed);
        expect(capturedUndoEmbed).toBeDefined();
        if (capturedUndoEmbed) {
            expect(capturedUndoEmbed.setTitle).toHaveBeenCalledWith('Undo Confirmed Title');
            expect(capturedUndoEmbed.setDescription).toHaveBeenCalledWith('Undo Confirmed Description');
            expect(capturedUndoEmbed.addFields).toHaveBeenCalledTimes(2);
            expect(capturedUndoEmbed.addFields).toHaveBeenCalledWith(expect.objectContaining({ name: player1.tag }));
        }

        expect(mockIntr.client.channels.fetch).toHaveBeenCalledWith(MOCK_CHANNEL_ID);
        
        // Asserting the edited message's embed content
        expect(messageUtilsEditMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: MOCK_MESSAGE_ID }), // originalMessage
            expect.objectContaining({ embeds: [expect.any(EmbedBuilder)] }) // options { embeds: [undidEmbed] }
        );
        
        const editCallArgs = messageUtilsEditMock.mock.calls[0];
        const editedEmbedOptions = editCallArgs[1] as { embeds: EmbedBuilder[] };
        const editedEmbedInstance = editedEmbedOptions.embeds[0];
        expect(editedEmbedInstance.setTitle).toHaveBeenCalledWith('Rank Undone Title');
        expect(editedEmbedInstance.setDescription).toHaveBeenCalledWith('Rank Undone Description');
        expect(editedEmbedInstance.setColor).toHaveBeenCalledWith('0xFFEE00');


        expect(messageUtilsClearReactionsMock).toHaveBeenCalled();
        expect(RankCommand.latestConfirmedRankOpDetails).toBeNull();
    });

    it('should disable a pending rank operation', async () => {
        const mockPendingInteraction = {
            fetchReply: vi.fn().mockResolvedValue({
                id: MOCK_MESSAGE_ID,
                // Ensure the embed here is also from a mocked EmbedBuilder for consistency
                embeds: [new EmbedBuilder().setTitle("Pending Rank").toJSON()],
            } as Message),
            guild: { id: MOCK_GUILD_ID }, // Add guild for consistency if undo logic might access it from interaction
            user: {id: "pendingUser"} as User,
            client: mockIntr.client // Share client mock
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
        expect(RankCommand.pendingRankUpdates.get(MOCK_MESSAGE_ID)?.status).toBe('disabled_by_undo');

        expect(interactionUtilsEditReplyMock).toHaveBeenCalledWith(mockPendingInteraction, expect.any(EmbedBuilder));
        
        const editReplyCallArgs = interactionUtilsEditReplyMock.mock.calls.find(call => call[0] === mockPendingInteraction);
        expect(editReplyCallArgs).toBeDefined();
        const disabledEmbed = editReplyCallArgs[1] as EmbedBuilder;

        expect(disabledEmbed.setTitle).toHaveBeenCalledWith('Rank Disabled Title');
        expect(disabledEmbed.setDescription).toHaveBeenCalledWith('Rank Disabled Description');
        expect(disabledEmbed.setColor).toHaveBeenCalledWith(0x808080); // Grey

        expect(messageUtilsClearReactionsMock).toHaveBeenCalled();
        
        let capturedSuccessEmbed: EmbedBuilder | undefined;
        langGetEmbedMock.mockImplementationOnce(() => { // For the success embed
            const embed = new EmbedBuilder() as EmbedBuilder;
            capturedSuccessEmbed = embed;
            return embed;
        });
        // Re-execute or ensure the send call is fresh if mocks are chained
        // For simplicity, here we assume the previous execute populated the calls correctly.
        // If this test were isolated, one might re-trigger the part of execute that sends success.
        // However, the flow of the command is one pass.

        await undoCommand.execute(mockIntr, mockEventData); // This call is for the success message path

        expect(interactionUtilsSendMock).toHaveBeenCalledWith(mockIntr, capturedSuccessEmbed);
        expect(langGetEmbedMock).toHaveBeenCalledWith("displayEmbeds.undoPendingSuccess", mockEventData.lang);
        if(capturedSuccessEmbed) {
            // Example assertion if success embed had specific content
            // expect(capturedSuccessEmbed.setTitle).toHaveBeenCalledWith("Pending Rank Disabled");
        }

        expect(RankCommand.latestPendingRankContext).toBeNull();
    });

    it('should inform if pending rank is already disabled', async () => {
        RankCommand.latestPendingRankContext = {
            guildId: MOCK_GUILD_ID, messageId: MOCK_MESSAGE_ID, channelId: MOCK_CHANNEL_ID,
            interaction: {
                guild: { id: MOCK_GUILD_ID },
                user: {id: "pendingUser"} as User,
                client: mockIntr.client
            } as ChatInputCommandInteraction,
        };
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, {
            status: 'disabled_by_undo',
        } as PendingRankUpdate);

        await undoCommand.execute(mockIntr, mockEventData);
        expect(langGetEmbedMock).toHaveBeenCalledWith('displayEmbeds.undoAlreadyDisabled', mockEventData.lang);
        
        const alreadyDisabledSendCallArgs = interactionUtilsSendMock.mock.calls.find(call => call[0] === mockIntr);
        expect(alreadyDisabledSendCallArgs).toBeDefined();
        expect(alreadyDisabledSendCallArgs[1]).toBeInstanceOf(EmbedBuilder);
        expect(alreadyDisabledSendCallArgs[2]).toBe(true);
    });

    it('should inform if there is nothing to undo', async () => {
        await undoCommand.execute(mockIntr, mockEventData);
        expect(langGetEmbedMock).toHaveBeenCalledWith('displayEmbeds.undoNothingToUndo', mockEventData.lang);
        
        const nothingSendCallArgs = interactionUtilsSendMock.mock.calls.find(call => call[0] === mockIntr);
        expect(nothingSendCallArgs).toBeDefined();
        expect(nothingSendCallArgs[1]).toBeInstanceOf(EmbedBuilder);
        expect(nothingSendCallArgs[2]).toBe(true);
    });

    it('should handle failure to revert confirmed rank gracefully', async () => {
        RankCommand.latestConfirmedRankOpDetails = {
            guildId: MOCK_GUILD_ID, messageId: MOCK_MESSAGE_ID, channelId: MOCK_CHANNEL_ID,
            players: [player1], timestamp: Date.now(),
        };
        playerRatingUpsertMock.mockRejectedValueOnce(new Error("DB Error"));

        await undoCommand.execute(mockIntr, mockEventData);

        expect(langGetEmbedMock).toHaveBeenCalledWith('errorEmbeds.undoFailed', mockEventData.lang);
        
        const errorSendCallArgs = interactionUtilsSendMock.mock.calls.find(call => call[0] === mockIntr);
        expect(errorSendCallArgs).toBeDefined();
        expect(errorSendCallArgs[1]).toBeInstanceOf(EmbedBuilder);
        expect(errorSendCallArgs[2]).toBe(true);
        
        // latestConfirmedRankOpDetails should still be set to allow retry or manual check
        expect(RankCommand.latestConfirmedRankOpDetails).not.toBeNull();
    });

    it('should handle failure to disable pending rank, reverting status and informing user', async () => {
        const mockPendingInteraction = {
            fetchReply: vi.fn().mockRejectedValue(new Error("Fetch reply failed")), // Make edit fail
            guild: { id: MOCK_GUILD_ID },
            user: {id: "pendingUser"} as User,
            client: mockIntr.client
        } as unknown as ChatInputCommandInteraction<CacheType>;
         RankCommand.latestPendingRankContext = {
            guildId: MOCK_GUILD_ID, messageId: MOCK_MESSAGE_ID, channelId: MOCK_CHANNEL_ID,
            interaction: mockPendingInteraction,
        };
        const pendingUpdate: PendingRankUpdate = {
            guildId: MOCK_GUILD_ID, playersToUpdate: [], interaction: mockPendingInteraction,
            lang: mockEventData.lang, upvoters: new Set(), status: 'active',
        };
        RankCommand.pendingRankUpdates.set(MOCK_MESSAGE_ID, pendingUpdate);

        await undoCommand.execute(mockIntr, mockEventData);

        expect(pendingUpdate.status).toBe('active'); // Should be reverted
        expect(langGetEmbedMock).toHaveBeenCalledWith('errorEmbeds.undoFailed', mockEventData.lang);

        const errorSendCall = interactionUtilsSendMock.mock.calls.find(call => call[0] === mockIntr);
        expect(errorSendCall).toBeDefined();
        expect(errorSendCall[1]).toBeInstanceOf(EmbedBuilder);
        expect(errorSendCall[2]).toBe(true);

        // latestPendingRankContext should still be set to allow retry or manual check
        expect(RankCommand.latestPendingRankContext).not.toBeNull();
    });
});