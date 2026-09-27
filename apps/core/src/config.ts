import { env, parseEnv, z, type Env } from '@hatti/config';

const common = {
  NODE_ENV: env.nodeEnv(),
  LOG_LEVEL: env.logLevel(),
  /** hatti_app login: row-level security applies. */
  DATABASE_URL: env.postgresUrl(),
  REDIS_URL: env.redisUrl(),
};

const apiSchema = z.object({
  ...common,
  HOST: z.string().default('0.0.0.0'),
  PORT: env.port().default(4000),
  /** Set when running behind a load balancer or Cloudflare, so client IPs are right. */
  TRUST_PROXY: env.flag().default(false),
  /** GraphiQL at /graphiql. Defaults to on in development only. */
  GRAPHIQL: env.flag().optional(),
});

const workerSchema = z.object({
  ...common,
  /** hatti_system login: the relay reads every shop's outbox rows. */
  DATABASE_SYSTEM_URL: env.postgresUrl(),
  /** Which loops this process runs; deploy them separately to scale them separately. */
  WORKER_ROLES: env
    .list()
    .pipe(z.array(z.enum(['relay', 'events'])).min(1))
    .default(['relay', 'events']),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  EVENT_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
});

const seedSchema = z.object({
  DATABASE_URL: env.postgresUrl(),
  DATABASE_SYSTEM_URL: env.postgresUrl(),
  PORT: env.port().default(4000),
});

export type ApiConfig = z.output<typeof apiSchema>;
export type WorkerConfig = z.output<typeof workerSchema>;
export type SeedConfig = z.output<typeof seedSchema>;

export const loadApiConfig = (source?: Env): ApiConfig => parseEnv(apiSchema, source);
export const loadWorkerConfig = (source?: Env): WorkerConfig => parseEnv(workerSchema, source);
export const loadSeedConfig = (source?: Env): SeedConfig => parseEnv(seedSchema, source);
