import { ActivityType, Client, ClientOptions, Presence } from 'discord.js';

export class CustomClient extends Client {
    constructor(clientOptions: ClientOptions) {
        super(clientOptions);
    }

    public setPresence(type: ActivityType, name: string, url?: string): Presence {
        if (!this.user) {
            throw new Error('Client user is not available to set presence.');
        }
        return this.user.setPresence({
            activities: [
                {
                    type,
                    name,
                    url,
                },
            ],
        });
    }
}
