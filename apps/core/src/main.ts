import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createRedis } from '@hatti/events';
import { HaveIBeenPwnedChecker, noBreachCheck } from '@hatti/identity/public';
import { createLogger } from '@hatti/logger';
import { RateLimiter } from '@hatti/ratelimit';
import { createApi } from './api/create-api.js';
import { loadApiConfig, passkeysOf } from './config.js';
import { couriersOf } from './couriers.js';
import { accountEmailsOf } from './emails.js';
import { ProviderPhoneCodes, messageProvidersOf } from './messaging.js';
import { hattiBankAccountOf, hattiGatewayOf } from './billing.js';
import { paymentGatewaysOf } from './payments.js';
import { onShutdown } from './shutdown.js';
import { LOCAL_STORAGE_PATH, createStorage } from './storage.js';

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
const publicUrl = config.PUBLIC_URL ?? `http://localhost:${config.PORT}`;
// Merchants' sign-in codes go out from here, at once (ADR-159): none where nothing can send them.
const messageProviders = messageProvidersOf(config, logger);

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
    passkeys: passkeysOf(config),
    phoneCodes:
      Object.keys(messageProviders).length > 0
        ? new ProviderPhoneCodes(messageProviders, logger)
        : null,
    google: config.GOOGLE_CLIENT_IDS ? { clientIds: config.GOOGLE_CLIENT_IDS } : null,
    emails: accountEmailsOf(config, logger),
  },
  trustProxy: config.TRUST_PROXY,
  graphiql: config.GRAPHIQL ?? config.NODE_ENV === 'development',
  maskInternalErrors: config.NODE_ENV === 'production',
  publicUrl,
  storage: createStorage(config, publicUrl),
  localStoragePath: LOCAL_STORAGE_PATH,
  storefrontUrl: config.STOREFRONT_URL,
  storefrontDnsTarget: config.STOREFRONT_DNS_TARGET,
  whatsapp:
    config.WHATSAPP_APP_SECRET && config.WHATSAPP_VERIFY_TOKEN
      ? { appSecret: config.WHATSAPP_APP_SECRET, verifyToken: config.WHATSAPP_VERIFY_TOKEN }
      : null,
  storefrontKey: config.STOREFRONT_SERVICE_KEY,
  couriers: couriersOf({ production: config.NODE_ENV === 'production' }),
  paymentGateways: paymentGatewaysOf({ production: config.NODE_ENV === 'production' }),
  billingGateway: hattiGatewayOf(config),
  billingBankAccount: hattiBankAccountOf(config),
});
await app.listen({ host: config.HOST, port: config.PORT });

onShutdown(logger, async () => {
  await app.close();
  await database.close();
  await identityDatabase.close();
  redis.disconnect();
});
