import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createLogger, errorTrackerOf, logUncaught } from '@hatti/logger';
import { supportSenderOf } from './billing.js';
import { consoleSignInOf, loadConsoleConfig } from './config.js';
import { createConsoleApi } from './console/console-app.js';
import { onShutdown } from './shutdown.js';

// Hatti's console's server (ADR-876): a process of its own, which the console's address alone
// passes requests to, never the API's. It holds the system login the queues of Hatti's people
// read every shop with, so the public API never does.
//
//   pnpm --filter @hatti/core console

const config = loadConsoleConfig();
const errorTracker = errorTrackerOf(config);
const logger = createLogger({ name: 'core-console', level: config.LOG_LEVEL, errorTracker });
logUncaught(logger, errorTracker);
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'core-console',
  onError: (error) => logger.warn({ err: error }, 'idle database connection failed'),
});
const identityDatabase = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'core-console:identity',
  onError: (error) => logger.warn({ err: error }, 'idle identity database connection failed'),
});
const app = await createConsoleApi({
  database,
  identityDb: identityDatabase.app,
  console: consoleSignInOf(config),
  supportSender: supportSenderOf(config),
  logger,
  trustProxy: config.TRUST_PROXY,
});
await app.listen({ host: config.HOST, port: config.CONSOLE_PORT });

onShutdown(logger, async () => {
  await app.close();
  await database.close();
  await identityDatabase.close();
});
