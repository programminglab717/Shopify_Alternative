import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createRedis } from '@hatti/events';
import { HaveIBeenPwnedChecker, noBreachCheck } from '@hatti/identity/public';
import { createLogger } from '@hatti/logger';
import { RateLimiter } from '@hatti/ratelimit';
import { createApi } from './api/create-api.js';
import { loadApiConfig } from './config.js';
import { onShutdown } from './shutdown.js';

const config = loadApiConfig();
const logger = createLogger({ name: 'core-api', level: config.LOG_LEVEL });
const database = new Database({
  appUrl: config.DATABASE_URL,
  applicationName: 'core-api',
  // The Admin API's budget (docs/architecture/12-scalability-and-reliability.md).
  transactionLimits: { statementTimeoutMs: 5_000 },
  onError: (error) => logger.warn({ err: error }, 'idle database connection failed'),
});
// Staff accounts and sessions are reachable only through their own login.
const identityDatabase = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'core-api:identity',
  onError: (error) => logger.warn({ err: error }, 'idle identity database connection failed'),
});
const redis = createRedis(config.REDIS_URL, 'producer');

const app = await createApi({
  database,
  logger,
  redis,
  identity: {
    db: identityDatabase.app,
    secretBox: config.ENCRYPTION_KEYS,
    rateLimiter: new RateLimiter(redis),
    onRateLimitError: (error) => logger.warn({ err: error }, 'rate limit check failed; allowing'),
    breachedPasswords: config.PASSWORD_BREACH_CHECK
      ? new HaveIBeenPwnedChecker({
          onError: (error) => logger.warn({ err: error }, 'breached-password check failed'),
        })
      : noBreachCheck,
  },
  trustProxy: config.TRUST_PROXY,
  graphiql: config.GRAPHIQL ?? config.NODE_ENV === 'development',
  maskInternalErrors: config.NODE_ENV === 'production',
  publicUrl: config.PUBLIC_URL ?? `http://localhost:${config.PORT}`,
  storefrontUrl: config.STOREFRONT_URL,
  storefrontDnsTarget: config.STOREFRONT_DNS_TARGET,
  storefrontKey: config.STOREFRONT_SERVICE_KEY,
});
await app.listen({ host: config.HOST, port: config.PORT });

onShutdown(logger, async () => {
  await app.close();
  await database.close();
  await identityDatabase.close();
  redis.disconnect();
});
