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

/**
 * Where files are kept (ADR-079), for the API, which keeps and shows them, and the worker, which
 * removes those whose records went (ADR-113): the two must name the same place.
 */
const storage = {
  /**
   * "s3" for R2, or any bucket the S3 API serves, as in production; "local" for a directory,
   * which the API serves at /storage, as in development.
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
};

/** The storage settings, as both processes read them. */
export type StorageConfig = z.output<z.ZodObject<typeof storage>>;

const storageComplete = (config: StorageConfig) =>
  config.STORAGE_DRIVER !== 's3' ||
  (config.S3_ENDPOINT !== undefined &&
    config.S3_BUCKET !== undefined &&
    config.S3_ACCESS_KEY_ID !== undefined &&
    config.S3_SECRET_ACCESS_KEY !== undefined);
const STORAGE_COMPLETE = {
  path: ['STORAGE_DRIVER'],
  message: 'Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for s3',
};
const storageShared = (config: StorageConfig & { NODE_ENV: string }) =>
  config.NODE_ENV !== 'production' || config.STORAGE_DRIVER === 's3';
const STORAGE_SHARED = {
  path: ['STORAGE_DRIVER'],
  message: "Must be s3 in production: a local directory is one machine's",
};

/**
 * How Hatti sends messages (ADR-146), for the worker, which sends shops' messages, and the API,
 * which sends the codes merchants sign in with (ADR-159) and Hatti's emails about accounts
 * (ADR-165).
 */
const messageSending = {
  /** Meta's Graph API, which conversions go to (ADR-143), and the version events go to. */
  META_GRAPH_URL: env.httpUrl().default('https://graph.facebook.com'),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'Expected a Graph API version, like v26.0')
    .default('v26.0'),
  /**
   * Hatti's shared WhatsApp notifications number (ADR-146): its ID in WhatsApp's Cloud API and a
   * system user's token for it, on META_GRAPH_URL at META_GRAPH_VERSION. Without them, messages go
   * to the log in development, and fail as unsent in production.
   */
  WHATSAPP_PHONE_NUMBER_ID: z
    .string()
    .regex(/^[0-9]{5,30}$/, 'Expected digits')
    .optional(),
  WHATSAPP_ACCESS_TOKEN: env.secret(20).optional(),
  /**
   * The SMS gateway (07 §3): where it takes a POST of `{ to, text, sender }`, its key and the
   * shared sender ID. Without them, as WhatsApp's.
   */
  SMS_GATEWAY_URL: env.httpUrl().optional(),
  SMS_GATEWAY_KEY: env.secret(16).optional(),
  SMS_SENDER: z.string().min(1).max(11).default('Hatti'),
  /**
   * Amazon SES, which sends Hatti's own emails about accounts (ADR-165), from the API, and shops'
   * emails to their customers about their orders (ADR-181), from the worker: its region and the
   * key of an IAM user allowed ses:SendEmail, and ses:GetSuppressedDestination and
   * ses:DeleteSuppressedDestination to lift an address from SES's own list as Hatti lifts it
   * (ADR-200). Without them, emails go to the log in development; in production no email is
   * proved, no password reset by email, and orders' emails fail as unsent.
   */
  SES_REGION: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'Expected an AWS region, like ap-southeast-1')
    .optional(),
  SES_ACCESS_KEY_ID: z
    .string()
    .regex(/^[A-Z0-9]{16,128}$/, 'Expected an AWS access key ID')
    .optional(),
  SES_SECRET_ACCESS_KEY: env.secret(20).optional(),
  /** SES's API, unless its region's: a local stand-in, as tests use. */
  SES_URL: env.httpUrl().optional(),
  /**
   * Whom Hatti's emails come from, at a domain SES has verified. A shop's emails to its customers
   * come from the same address, under the shop's name.
   */
  EMAIL_FROM: z.string().min(3).default('Hatti <no-reply@hatti.pk>'),
};

/** The message-sending settings, as both processes read them, with the environment's name. */
export type MessageSendingConfig = z.output<z.ZodObject<typeof messageSending>> & {
  NODE_ENV: string;
};

const whatsAppPaired = (config: MessageSendingConfig) =>
  (config.WHATSAPP_PHONE_NUMBER_ID === undefined) === (config.WHATSAPP_ACCESS_TOKEN === undefined);
const WHATSAPP_PAIRED = {
  path: ['WHATSAPP_ACCESS_TOKEN'],
  message: 'Set both WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN, or neither',
};
const smsPaired = (config: MessageSendingConfig) =>
  (config.SMS_GATEWAY_URL === undefined) === (config.SMS_GATEWAY_KEY === undefined);
const SMS_PAIRED = {
  path: ['SMS_GATEWAY_KEY'],
  message: 'Set both SMS_GATEWAY_URL and SMS_GATEWAY_KEY, or neither',
};
const sesComplete = (
  config: Pick<MessageSendingConfig, 'SES_REGION' | 'SES_ACCESS_KEY_ID' | 'SES_SECRET_ACCESS_KEY'>,
) => {
  const set = [config.SES_REGION, config.SES_ACCESS_KEY_ID, config.SES_SECRET_ACCESS_KEY].filter(
    (value) => value !== undefined,
  );
  return set.length === 0 || set.length === 3;
};
const SES_COMPLETE = {
  path: ['SES_SECRET_ACCESS_KEY'],
  message: 'Set SES_REGION, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY together, or none',
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
     * Hatti's OAuth client IDs at Google, comma-separated, the admin's first and then the apps'
     * (ADR-164): "123-abc.apps.googleusercontent.com". Without them, no one signs in with Google.
     */
    GOOGLE_CLIENT_IDS: env
      .list()
      .pipe(
        z
          .array(
            z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, {
              message: 'Expected client IDs Google gave, ending .apps.googleusercontent.com',
            }),
          )
          .min(1),
      )
      .optional(),
    /**
     * Where staff use the admin: "https://admin.hatti.pk". The links in Hatti's emails about
     * accounts open there (ADR-165); the first of PASSKEY_ORIGINS unless set.
     */
    ADMIN_URL: env.httpUrl().optional(),
    /**
     * The SNS topic SES publishes Hatti's bounces and complaints to (ADR-170), subscribed to
     * {PUBLIC_URL}/webhooks/ses: an address that bounced for good, or complained, is sent no more.
     */
    SES_FEEDBACK_TOPIC_ARN: z
      .string()
      .regex(
        /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/,
        'Expected an SNS topic ARN, like arn:aws:sns:ap-south-1:123456789012:hatti-ses-feedback',
      )
      .optional(),
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
     * WhatsApp's webhook (ADR-146): the secret of Hatti's app, which Meta signs requests with, and
     * the token agreed when the webhook was set up. Without both, /webhooks/whatsapp answers 404.
     */
    WHATSAPP_APP_SECRET: env.secret(16).optional(),
    WHATSAPP_VERIFY_TOKEN: env.secret(16).optional(),
    /**
     * Hatti's own Safepay account, which shops pay their plans through (ADR-154): its API key,
     * secret key and webhook secret, all three or none, and its environment. Without them, the
     * test gateway outside production, and invoices are not paid online in production. Its
     * webhook is {PUBLIC_URL}/webhooks/billing.
     */
    BILLING_SAFEPAY_ENVIRONMENT: z.enum(['sandbox', 'production']).default('production'),
    BILLING_SAFEPAY_API_KEY: z.string().min(1).optional(),
    BILLING_SAFEPAY_SECRET_KEY: env.secret(16).optional(),
    BILLING_SAFEPAY_WEBHOOK_SECRET: env.secret(16).optional(),
    ...messageSending,
    ...storage,
  })
  .refine(
    (config) =>
      (config.WHATSAPP_APP_SECRET === undefined) === (config.WHATSAPP_VERIFY_TOKEN === undefined),
    {
      path: ['WHATSAPP_VERIFY_TOKEN'],
      message: 'Set both WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN, or neither',
    },
  )
  .refine(
    (config) =>
      new Set([
        config.BILLING_SAFEPAY_API_KEY === undefined,
        config.BILLING_SAFEPAY_SECRET_KEY === undefined,
        config.BILLING_SAFEPAY_WEBHOOK_SECRET === undefined,
      ]).size === 1,
    {
      path: ['BILLING_SAFEPAY_WEBHOOK_SECRET'],
      message:
        'Set BILLING_SAFEPAY_API_KEY, BILLING_SAFEPAY_SECRET_KEY and ' +
        'BILLING_SAFEPAY_WEBHOOK_SECRET together, or none of them',
    },
  )
  .refine(storageComplete, STORAGE_COMPLETE)
  .refine(storageShared, STORAGE_SHARED)
  .refine(whatsAppPaired, WHATSAPP_PAIRED)
  .refine(smsPaired, SMS_PAIRED)
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
  .refine(sesComplete, SES_COMPLETE)
  .refine((config) => !config.SES_FEEDBACK_TOPIC_ARN || config.SES_REGION !== undefined, {
    path: ['SES_FEEDBACK_TOPIC_ARN'],
    message: "Set SES's own settings too: the topic tells of the emails SES sends",
  })
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
    /** How often articles published at a time ahead are shown once it comes (ADR-215). */
    ARTICLES_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
    EVENT_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * Cloudflare, the edge in front of storefronts (ADR-007): the zone storefront pages are kept in,
     * and a token that may purge its cache. The publisher purges what changes (ADR-047); without
     * them, nothing is purged.
     */
    CLOUDFLARE_ZONE_ID: z.string().min(1).optional(),
    CLOUDFLARE_API_TOKEN: env.secret(20).optional(),
    /**
     * The API's keys for secrets at rest: the conversions sender opens shops' Meta access tokens
     * with them (ADR-143), and the courier bookings their couriers' credentials (ADR-149).
     * Without them, no conversions are sent, and no orders are booked with couriers.
     */
    ENCRYPTION_KEYS: encryptionKeys().optional(),
    /**
     * Where storefronts answer, as the API's: conversions name the shop's address. Required in
     * production; http://localhost:4100 otherwise.
     */
    STOREFRONT_URL: env.httpUrl().optional(),
    /**
     * The API's public address, as its PUBLIC_URL: messages link customers' order pages there
     * (ADR-147). Required in production; http://localhost:4000 otherwise.
     */
    PUBLIC_URL: env.httpUrl().optional(),
    /** How often the moments of orders due go to the ad platforms. */
    CONVERSIONS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
    /** How often messages due go out. */
    MESSAGES_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    /** PostEx's merchant API, which its bookings go to (ADR-149). */
    POSTEX_URL: env.httpUrl().default('https://api.postex.pk/services/integration/api/order'),
    /** Leopards' merchant API, which its bookings go to (ADR-162); its staging API in tests. */
    LEOPARDS_URL: env.httpUrl().default('https://merchantapi.leopardscourier.com/api'),
    /** How often bookings due are booked with couriers, and parcels due are asked about. */
    COURIER_BOOKINGS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
    /** How often products' images due are made ready, and those of media gone removed. */
    IMAGES_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    /** How often the storefronts' counts of each day's sessions are kept (ADR-180). */
    SESSIONS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
    ...messageSending,
    ...storage,
  })
  .refine(whatsAppPaired, WHATSAPP_PAIRED)
  .refine(smsPaired, SMS_PAIRED)
  .refine(sesComplete, SES_COMPLETE)
  .refine(
    (config) =>
      (config.CLOUDFLARE_ZONE_ID === undefined) === (config.CLOUDFLARE_API_TOKEN === undefined),
    {
      path: ['CLOUDFLARE_API_TOKEN'],
      message: 'Set both CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN, or neither',
    },
  )
  .refine((config) => config.NODE_ENV !== 'production' || config.STOREFRONT_URL !== undefined, {
    path: ['STOREFRONT_URL'],
    message: "Required in production: conversions name shops' storefronts there",
  })
  .refine((config) => config.NODE_ENV !== 'production' || config.PUBLIC_URL !== undefined, {
    path: ['PUBLIC_URL'],
    message: "Required in production: messages link customers' order pages there",
  })
  .refine(storageComplete, STORAGE_COMPLETE)
  .refine(storageShared, STORAGE_SHARED);

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

/** Hatti's support agents are added and removed with the identity login alone (ADR-156). */
const supportAgentSchema = z.object({ DATABASE_IDENTITY_URL: env.postgresUrl() });

/**
 * Hatti's operators see and lift suppressed addresses with the identity login, and SES's keys
 * where SES is set up, to keep its own list in step (ADR-200).
 */
const emailSuppressionSchema = z
  .object({
    DATABASE_IDENTITY_URL: env.postgresUrl(),
    SES_REGION: messageSending.SES_REGION,
    SES_ACCESS_KEY_ID: messageSending.SES_ACCESS_KEY_ID,
    SES_SECRET_ACCESS_KEY: messageSending.SES_SECRET_ACCESS_KEY,
    SES_URL: messageSending.SES_URL,
    EMAIL_FROM: messageSending.EMAIL_FROM,
  })
  .refine(sesComplete, SES_COMPLETE);

export type ApiConfig = z.output<typeof apiSchema>;
export type WorkerConfig = z.output<typeof workerSchema>;
export type SeedConfig = z.output<typeof seedSchema>;
export type SupportAgentConfig = z.output<typeof supportAgentSchema>;
export type EmailSuppressionConfig = z.output<typeof emailSuppressionSchema>;

export const loadApiConfig = (source?: Env): ApiConfig => parseEnv(apiSchema, source);
export const loadWorkerConfig = (source?: Env): WorkerConfig => parseEnv(workerSchema, source);
export const loadSeedConfig = (source?: Env): SeedConfig => parseEnv(seedSchema, source);
export const loadSupportAgentConfig = (source?: Env): SupportAgentConfig =>
  parseEnv(supportAgentSchema, source);
export const loadEmailSuppressionConfig = (source?: Env): EmailSuppressionConfig =>
  parseEnv(emailSuppressionSchema, source);
