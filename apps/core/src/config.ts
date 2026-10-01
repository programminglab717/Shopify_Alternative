import { env, parseEnv, z, type Env } from '@hatti/config';
import { SecretBox } from '@hatti/crypto';

/** "id:base64key,…", newest first. Parsed at startup so a bad key stops the process. */
const encryptionKeys = () =>
  z.string().transform((spec, context) => {
    try {
      return SecretBox.fromString(spec);
    } catch (error) {
      context.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });

const identity = {
  /** hatti_identity login: staff accounts, credentials and sessions. */
  DATABASE_IDENTITY_URL: env.postgresUrl(),
  /** Keys for secrets at rest, such as authenticator-app seeds. */
  ENCRYPTION_KEYS: encryptionKeys(),
};

const common = {
  NODE_ENV: env.nodeEnv(),
  LOG_LEVEL: env.logLevel(),
  /** hatti_app login: row-level security applies. */
  DATABASE_URL: env.postgresUrl(),
  REDIS_URL: env.redisUrl(),
};

const apiSchema = z
  .object({
    ...common,
    ...identity,
    /** Check new passwords against known breaches (Pwned Passwords, k-anonymity). */
    PASSWORD_BREACH_CHECK: env.flag().default(true),
    HOST: z.string().default('0.0.0.0'),
    PORT: env.port().default(4000),
    /** Set when running behind a load balancer or Cloudflare, so client IPs are right. */
    TRUST_PROXY: env.flag().default(false),
    /** GraphiQL at /graphiql. Defaults to on in development only. */
    GRAPHIQL: env.flag().optional(),
    /**
     * Where customers reach this API's public pages, such as draft orders' links:
     * "https://hatti.pk". Required in production; http://localhost:PORT otherwise.
     */
    PUBLIC_URL: env.httpUrl().optional(),
    /**
     * Where storefronts answer, each at its shop's handle's subdomain: "https://hatti.pk" for
     * zari.hatti.pk. Required in production; http://localhost:4100 otherwise.
     */
    STOREFRONT_URL: env.httpUrl().optional(),
    /**
     * The domain staff's passkeys belong to (ADR-100), the admin's own or a parent of it:
     * "hatti.pk". PUBLIC_URL's host unless set.
     */
    PASSKEY_RP_ID: z
      .string()
      .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, {
        message: 'Expected a host name',
      })
      .optional(),
    /**
     * The origins staff sign in from with passkeys, comma-separated: "https://admin.hatti.pk".
     * PUBLIC_URL's origin unless set; each on PASSKEY_RP_ID or under it.
     */
    PASSKEY_ORIGINS: env.list().pipe(z.array(env.httpUrl()).min(1)).optional(),
    /**
     * Where shops point domains of their own with a CNAME record (ADR-048): shops.{STOREFRONT_URL's
     * host} unless set, as Cloudflare for SaaS's target is named.
     */
    STOREFRONT_DNS_TARGET: z
      .string()
      .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Expected a host name')
      .optional(),
    /**
     * The key storefronts present to the /storefront/ routes, such as carts' (ADR-042): at least
     * 32 characters. Required in production; without it, those routes are not served.
     */
    STOREFRONT_SERVICE_KEY: z.string().min(32).optional(),
    /**
     * Where files are kept (ADR-079): "s3" for R2, or any bucket the S3 API serves, as in
     * production; "local" for a directory, which the API serves at /storage, as in development.
     */
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    /** Where local storage keeps files: .storage, in the working directory, unless set. */
    STORAGE_DIRECTORY: z.string().min(1).default('.storage'),
    /** What local storage signs its URLs with: 32 characters or more; new at each start unless set. */
    STORAGE_SECRET: z.string().min(32).optional(),
    /** The S3 API's address, without the bucket: "https://{account}.r2.cloudflarestorage.com". */
    S3_ENDPOINT: env.httpUrl().optional(),
    S3_BUCKET: z.string().min(3).optional(),
    /** "auto" for R2. */
    S3_REGION: z.string().min(1).default('auto'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: env.secret(20).optional(),
  })
  .refine(
    (config) =>
      config.STORAGE_DRIVER !== 's3' ||
      (config.S3_ENDPOINT !== undefined &&
        config.S3_BUCKET !== undefined &&
        config.S3_ACCESS_KEY_ID !== undefined &&
        config.S3_SECRET_ACCESS_KEY !== undefined),
    {
      path: ['STORAGE_DRIVER'],
      message: 'Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for s3',
    },
  )
  .refine((config) => config.NODE_ENV !== 'production' || config.STORAGE_DRIVER === 's3', {
    path: ['STORAGE_DRIVER'],
    message: "Must be s3 in production: a local directory is one machine's",
  })
  .refine((config) => config.NODE_ENV !== 'production' || config.PUBLIC_URL !== undefined, {
    path: ['PUBLIC_URL'],
    message: 'Required in production: links sent to customers point there',
  })
  .refine((config) => config.NODE_ENV !== 'production' || config.STOREFRONT_URL !== undefined, {
    path: ['STOREFRONT_URL'],
    message: 'Required in production: merchants are shown their storefronts there',
  })
  .refine(
    (config) => config.NODE_ENV !== 'production' || config.STOREFRONT_SERVICE_KEY !== undefined,
    {
      path: ['STOREFRONT_SERVICE_KEY'],
      message: "Required in production: storefronts keep shoppers' carts through it",
    },
  )
  .refine(
    (config) => {
      const { rpId, origins } = passkeysOf(config);
      return origins.every((origin) => {
        const host = new URL(origin).hostname;
        return host === rpId || host.endsWith(`.${rpId}`);
      });
    },
    {
      path: ['PASSKEY_ORIGINS'],
      message: 'Each origin must be on PASSKEY_RP_ID or under it, as WebAuthn asks',
    },
  );

/**
 * Where staff sign in with passkeys (ADR-100): PASSKEY_RP_ID and PASSKEY_ORIGINS, or PUBLIC_URL's
 * host and origin, http://localhost:PORT's in development.
 */
export function passkeysOf(
  config: Pick<ApiConfig, 'PASSKEY_RP_ID' | 'PASSKEY_ORIGINS' | 'PUBLIC_URL' | 'PORT'>,
): { rpId: string; rpName: string; origins: string[] } {
  const publicUrl = new URL(config.PUBLIC_URL ?? `http://localhost:${config.PORT}`);
  return {
    rpId: config.PASSKEY_RP_ID ?? publicUrl.hostname,
    rpName: 'Hatti',
    origins: (config.PASSKEY_ORIGINS ?? [publicUrl.origin]).map((origin) => new URL(origin).origin),
  };
}

const workerSchema = z
  .object({
    ...common,
    /** hatti_system login: the relay reads every shop's outbox rows. */
    DATABASE_SYSTEM_URL: env.postgresUrl(),
    /**
     * hatti_system login for the relay's LISTEN, which needs a direct connection to Postgres. Set it
     * when DATABASE_SYSTEM_URL goes through PgBouncer; defaults to DATABASE_SYSTEM_URL.
     */
    DATABASE_LISTEN_URL: env.postgresUrl().optional(),
    /**
     * Which loops this process runs; deploy them separately to scale them separately. `sweeps` are
     * jobs on a timer, such as giving up on customers who can't be reached (ADR-092).
     */
    WORKER_ROLES: env
      .list()
      .pipe(z.array(z.enum(['relay', 'events', 'sweeps'])).min(1))
      .default(['relay', 'events', 'sweeps']),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
    /** How often the sweeps run. */
    SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(600_000),
    EVENT_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * Cloudflare, the edge in front of storefronts (ADR-007): the zone storefront pages are kept in,
     * and a token that may purge its cache. The publisher purges what changes (ADR-047); without
     * them, nothing is purged.
     */
    CLOUDFLARE_ZONE_ID: z.string().min(1).optional(),
    CLOUDFLARE_API_TOKEN: env.secret(20).optional(),
  })
  .refine(
    (config) =>
      (config.CLOUDFLARE_ZONE_ID === undefined) === (config.CLOUDFLARE_API_TOKEN === undefined),
    {
      path: ['CLOUDFLARE_API_TOKEN'],
      message: 'Set both CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN, or neither',
    },
  );

const seedSchema = z.object({
  ...identity,
  DATABASE_URL: env.postgresUrl(),
  DATABASE_SYSTEM_URL: env.postgresUrl(),
  /** Where the demo shop's storefront is published. */
  REDIS_URL: env.redisUrl(),
  /** Where storefronts answer, for the demo shop's address. */
  STOREFRONT_URL: env.httpUrl().default('http://localhost:4100'),
  PORT: env.port().default(4000),
  /** For the sample draft order's link. */
  PUBLIC_URL: env.httpUrl().optional(),
});

export type ApiConfig = z.output<typeof apiSchema>;
export type WorkerConfig = z.output<typeof workerSchema>;
export type SeedConfig = z.output<typeof seedSchema>;

export const loadApiConfig = (source?: Env): ApiConfig => parseEnv(apiSchema, source);
export const loadWorkerConfig = (source?: Env): WorkerConfig => parseEnv(workerSchema, source);
export const loadSeedConfig = (source?: Env): SeedConfig => parseEnv(seedSchema, source);
