import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createRedis } from '@hatti/events';
import { createLogger } from '@hatti/logger';
import { createApi } from './api/create-api.js';
import { loadApiConfig } from './config.js';
import { onShutdown } from './shutdown.js';

const config = loadApiConfig();
const logger = createLogger({ name: 'core-api', level: config.LOG_LEVEL });
const database = new Database({
  appUrl: config.DATABASE_URL,
  applicationName: 'core-api',
  onError: (error) => logger.warn({ err: error }, 'idle database connection failed'),
});
const redis = createRedis(config.REDIS_URL, 'producer');

const app = await createApi({
  database,
  logger,
  redis,
  trustProxy: config.TRUST_PROXY,
  graphiql: config.GRAPHIQL ?? config.NODE_ENV === 'development',
  maskInternalErrors: config.NODE_ENV === 'production',
});
await app.listen({ host: config.HOST, port: config.PORT });

onShutdown(logger, async () => {
  await app.close();
  await database.close();
  redis.disconnect();
});
