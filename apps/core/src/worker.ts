import { createLogger } from '@hatti/logger';
import { loadWorkerConfig } from './config.js';
import { onShutdown } from './shutdown.js';
import { startWorker } from './worker/start-worker.js';

const config = loadWorkerConfig();
const logger = createLogger({ name: 'core-worker', level: config.LOG_LEVEL });
const worker = await startWorker(config, logger);
onShutdown(logger, () => worker.stop());
