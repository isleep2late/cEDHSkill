import express, { Express, json } from 'express';
import { createRequire } from 'node:module';

import { Controller } from '../controllers/index.js';
import { checkAuth, handleError } from '../middleware/index.js';
import { Logger } from '../services/index.js';

const require = createRequire(import.meta.url);
let Config = require('../../config/config.json');
let Logs = require('../../lang/logs.json');

export class Api {
    private app: Express;

    constructor(public controllers: Controller[]) {
        this.app = express();
        this.app.use(json());
        this.setupControllers();
        this.app.use(handleError());
    }

    public async start(): Promise<void> {
        const port = Number(Config.api.port);
        return await new Promise<void>((resolve, reject) => {
            const server = this.app.listen(port, () => {
                Logger.info(Logs.info.apiStarted.replaceAll('{PORT}', port.toString()));
                resolve();
            });
            server.on('error', (err: Error) => {
                Logger.error(`API failed to start on port ${port}. Error: ${err.message}`, err);
                reject(err);
            });
        });
    }

    private setupControllers(): void {
        for (let controller of this.controllers) {
            if (controller.authToken) {
                controller.router.use(checkAuth(controller.authToken));
            }
            controller.register();
            this.app.use(controller.path, controller.router);
        }
    }
}
