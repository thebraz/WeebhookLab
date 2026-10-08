import { DEFAULT_DATABASE } from './app.js';
import { runCli, dataDirectory } from './cli.js';
import { join } from 'node:path';

// Source startup keeps the existing database; the installed CLI uses per-user storage.
await runCli(process.env.WEEBHOOKLAB_DATA_DIR ? join(dataDirectory(), 'events.sqlite') : DEFAULT_DATABASE);
