import { Locale, CommandInteraction } from 'discord.js';

// This class is used to store and pass data along in events
export class EventData {
    // TODO: Add any data you want to store
    constructor(
        // Event language
        public lang: Locale,
        // Guild language
        public langGuild: Locale,
        // Command arguments
        public args?: CommandInteraction['options']
    ) {}
}
