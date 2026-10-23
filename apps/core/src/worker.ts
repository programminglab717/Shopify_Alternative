import { createLogger, errorTrackerOf, logUncaught } from '@hatti/logger';
import { loadWorkerConfig } from './config.js';
import { onShutdown } from './shutdown.js';
import { startWorker } from './worker/start-worker.js';

const config = loadWorkerConfig();
// Errors go to the error tracker too, once its DSN is set (ADR-743).
const errorTracker = errorTrackerOf(config);
const logger = createLogger({ name: 'core-worker', level: config.LOG_LEVEL, errorTracker });
logUncaught(logger, errorTracker);
const worker = await startWorker(config, logger);
onShutdown(logger, () => worker.stop().then(() => errorTracker?.flush()));
