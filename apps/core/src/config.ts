import { env, parseEnv, z, type Env } from '@hatti/config';
import { SecretBox } from '@hatti/crypto';
import { parseDsn } from '@hatti/logger';
import type { GoogleAdsOptions } from '@hatti/marketing/public';
import { DarazClient } from '@hatti/orders/public';
import { normalizePkIban, parsePkMobile } from '@hatti/pk';
import { FBR_DI_URLS } from '@hatti/tax/public';
import { STATUS_COMPONENTS, type StatusComponent } from '@hatti/trust/public';
import type { QueryCostLimits } from './api/query-cost.js';

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

/** A Pakistani IBAN, checked and unspaced: "PK36SCBL0000001123456702". */
const pkIban = () =>
  z.string().transform((value, context) => {
    const iban = normalizePkIban(value);
    if (!iban) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a Pakistani IBAN: PK, 2 check digits, 4 letters and 16 digits',
      });
      return z.NEVER;
    }
    return iban;
  });

/** A Pakistani mobile number, in E.164: "+923001234567". */
const pkMobile = () =>
  z.string().transform((value, context) => {
    const number = parsePkMobile(value);
    if (!number) {
      context.addIssue({ code: 'custom', message: 'Expected a Pakistani mobile number' });
      return z.NEVER;
    }
    return number.e164;
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
  /**
   * Meta's Graph API, which conversions go to (ADR-143) and shops' ad accounts' spend is read from
   * (ADR-564), and the version asked.
   */
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
   * The voice gateway (07 §3, ADR-611), which places automated calls in Urdu to confirm orders:
   * where it takes a POST of `{ to, text, language, keys, reference, callbackUrl }`, its key, and
   * the secret it signs what it posts to /webhooks/voice with. All three or none; without them, no
   * call is placed, in production, and calls go to the log in development.
   */
  VOICE_GATEWAY_URL: env.httpUrl().optional(),
  VOICE_GATEWAY_KEY: env.secret(16).optional(),
  VOICE_WEBHOOK_SECRET: env.secret(16).optional(),
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

/**
 * TikTok's Business API, as the worker and the API read it: shops' orders go to it through its
 * Events API (ADR-541), and their advertiser accounts are checked on it and their spend pulled
 * from it (ADR-566).
 */
const tiktokApi = {
  TIKTOK_API_URL: env.httpUrl().default('https://business-api.tiktok.com'),
};

/**
 * The Google Ads API and Google's OAuth, as the worker and the API read them: shops grant Hatti
 * the reading of their Google Ads accounts on Google's consent screen, through Hatti's own OAuth
 * client, and their spend is pulled with Hatti's developer token (ADR-678). The developer token
 * and the client's ID and secret together, or none: without them, no Google Ads account connects.
 */
const googleAds = {
  GOOGLE_ADS_API_URL: env.httpUrl().default('https://googleads.googleapis.com'),
  GOOGLE_ADS_API_VERSION: z
    .string()
    .regex(/^v\d{1,3}$/, 'Expected a Google Ads API version, like v21')
    .default('v21'),
  GOOGLE_OAUTH_AUTHORIZE_URL: env.httpUrl().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_OAUTH_TOKEN_URL: env.httpUrl().default('https://oauth2.googleapis.com/token'),
  GOOGLE_ADS_DEVELOPER_TOKEN: env.secret(16).optional(),
  GOOGLE_ADS_CLIENT_ID: z
    .string()
    .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, 'Expected an OAuth client ID of Google')
    .optional(),
  GOOGLE_ADS_CLIENT_SECRET: env.secret(16).optional(),
};
const googleAdsComplete = (config: {
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
}) => {
  const set = [
    config.GOOGLE_ADS_DEVELOPER_TOKEN,
    config.GOOGLE_ADS_CLIENT_ID,
    config.GOOGLE_ADS_CLIENT_SECRET,
  ].filter((value) => value !== undefined);
  return set.length === 0 || set.length === 3;
};
const GOOGLE_ADS_COMPLETE = {
  path: ['GOOGLE_ADS_CLIENT_SECRET'],
  message:
    'Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET together, ' +
    'or none',
};

/** The Google Ads API and Google's OAuth as Hatti is set up with them, for its Google Ads client. */
export function googleAdsOptions(
  config: z.output<z.ZodObject<typeof googleAds>>,
): GoogleAdsOptions {
  return {
    baseUrl: config.GOOGLE_ADS_API_URL,
    version: config.GOOGLE_ADS_API_VERSION,
    authorizeUrl: config.GOOGLE_OAUTH_AUTHORIZE_URL,
    tokenUrl: config.GOOGLE_OAUTH_TOKEN_URL,
    developerToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: config.GOOGLE_ADS_CLIENT_ID,
    clientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
  };
}

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
/**
 * Hatti's support WhatsApp number on WhatsApp's Cloud API (ADR-560), for the API, which keeps what
 * shops' staff write to it as their shops' support requests, and Hatti's people's tool, which
 * answers them from it: its ID, and a system user's token for it, both or neither. Without them,
 * what is written to it is not kept, and answers are shown in the admin alone.
 */
const supportWhatsApp = {
  SUPPORT_WHATSAPP_PHONE_NUMBER_ID: z
    .string()
    .regex(/^[0-9]{5,30}$/, 'Expected digits')
    .optional(),
  SUPPORT_WHATSAPP_ACCESS_TOKEN: env.secret(20).optional(),
};

const supportWhatsAppPaired = (config: z.output<z.ZodObject<typeof supportWhatsApp>>) =>
  (config.SUPPORT_WHATSAPP_PHONE_NUMBER_ID === undefined) ===
  (config.SUPPORT_WHATSAPP_ACCESS_TOKEN === undefined);
const SUPPORT_WHATSAPP_PAIRED = {
  path: ['SUPPORT_WHATSAPP_ACCESS_TOKEN'],
  message:
    'Set both SUPPORT_WHATSAPP_PHONE_NUMBER_ID and SUPPORT_WHATSAPP_ACCESS_TOKEN, or neither',
};

const smsPaired = (config: MessageSendingConfig) =>
  (config.SMS_GATEWAY_URL === undefined) === (config.SMS_GATEWAY_KEY === undefined);
const SMS_PAIRED = {
  path: ['SMS_GATEWAY_KEY'],
  message: 'Set both SMS_GATEWAY_URL and SMS_GATEWAY_KEY, or neither',
};
const voiceComplete = (config: MessageSendingConfig) =>
  new Set([
    config.VOICE_GATEWAY_URL === undefined,
    config.VOICE_GATEWAY_KEY === undefined,
    config.VOICE_WEBHOOK_SECRET === undefined,
  ]).size === 1;
const VOICE_COMPLETE = {
  path: ['VOICE_WEBHOOK_SECRET'],
  message: 'Set VOICE_GATEWAY_URL, VOICE_GATEWAY_KEY and VOICE_WEBHOOK_SECRET, or none',
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

/**
 * Hatti's VAPID keys (ADR-506), which pushes to staff's browsers are signed with: the public key,
 * uncompressed, and the private one, base64url, as `pnpm --filter @hatti/core vapid-keys` makes
 * them, and who runs Hatti, for push services to reach. All three or none; without them, nothing
 * is pushed. The API gives browsers the public key; the worker signs with the private one.
 */
const webPush = {
  VAPID_PUBLIC_KEY: z
    .string()
    .regex(/^B[A-Za-z0-9_-]{86}$/, 'Expected an uncompressed P-256 public key, base64url')
    .optional(),
  VAPID_PRIVATE_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'Expected a P-256 private key, base64url')
    .optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'Expected a mailto: or https: address')
    .optional(),
};
export type WebPushConfig = z.output<z.ZodObject<typeof webPush>>;
const webPushComplete = (config: WebPushConfig) =>
  new Set([
    config.VAPID_PUBLIC_KEY === undefined,
    config.VAPID_PRIVATE_KEY === undefined,
    config.VAPID_SUBJECT === undefined,
  ]).size === 1;
const WEB_PUSH_COMPLETE = {
  path: ['VAPID_SUBJECT'],
  message: 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together, or none',
};

/** Hatti's VAPID keys, where it has them. */
export function vapidKeysOf(
  config: WebPushConfig,
): { publicKey: string; privateKey: string; subject: string } | null {
  return config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
    ? {
        publicKey: config.VAPID_PUBLIC_KEY,
        privateKey: config.VAPID_PRIVATE_KEY,
        subject: config.VAPID_SUBJECT,
      }
    : null;
}

/** A host name shops point their own domains at (ADR-048), as both the API and the worker read it. */
const storefrontDnsTarget = z
  .string()
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Expected a host name')
  .optional();

/**
 * The AI gateway (ADR-463): the model provider's API key and the model's ID, both or neither, and
 * the provider's address where it is not Anthropic's own, as for a proxy. No model is named in
 * code: changing it is a change here. Without them, nothing is drafted with AI, and the worker
 * answers no customer with it (ADR-849).
 */
const aiGateway = {
  AI_API_KEY: env.secret(16).optional(),
  AI_MODEL: z.string().trim().min(1).max(200).optional(),
  AI_BASE_URL: env.httpUrl().optional(),
};

/**
 * Hatti's own speech-to-text server (ADR-871), which hears customers' WhatsApp voice notes for the
 * shops that take orders by them: whisper.cpp's server at its /inference address, or any that
 * answers as OpenAI's transcriptions do, with a key where it asks for one. Without it, voice notes
 * wait for staff, unheard.
 */
const speechToText = {
  SPEECH_TO_TEXT_URL: env.httpUrl().optional(),
  SPEECH_TO_TEXT_KEY: env.secret(8).optional(),
  SPEECH_TO_TEXT_MODEL: z.string().trim().min(1).max(200).optional(),
};

/**
 * Hatti's app on Daraz's Open Platform (ADR-875): its key and secret, both or neither, and the
 * platform's addresses for Pakistan. Without them, shops cannot connect Daraz.
 */
const daraz = {
  DARAZ_APP_KEY: z.string().trim().min(1).max(64).optional(),
  DARAZ_APP_SECRET: env.secret(16).optional(),
  DARAZ_API_URL: env.httpUrl().default('https://api.daraz.pk/rest'),
  DARAZ_AUTH_URL: env.httpUrl().default('https://auth.daraz.com/rest'),
  DARAZ_AUTHORIZE_URL: env.httpUrl().default('https://api.daraz.pk/oauth/authorize'),
};

const darazPaired = (config: { DARAZ_APP_KEY?: string; DARAZ_APP_SECRET?: string }) =>
  (config.DARAZ_APP_KEY === undefined) === (config.DARAZ_APP_SECRET === undefined);
const DARAZ_PAIRED = {
  path: ['DARAZ_APP_SECRET'],
  message: 'Set both DARAZ_APP_KEY and DARAZ_APP_SECRET, or neither',
};

/** Daraz's client, from the configuration; null without its app's key. */
export function darazClientOf(config: {
  DARAZ_APP_KEY?: string;
  DARAZ_APP_SECRET?: string;
  DARAZ_API_URL: string;
  DARAZ_AUTH_URL: string;
  DARAZ_AUTHORIZE_URL: string;
}): DarazClient | null {
  return config.DARAZ_APP_KEY && config.DARAZ_APP_SECRET
    ? new DarazClient({
        appKey: config.DARAZ_APP_KEY,
        appSecret: config.DARAZ_APP_SECRET,
        apiUrl: config.DARAZ_API_URL,
        authUrl: config.DARAZ_AUTH_URL,
        authorizeUrl: config.DARAZ_AUTHORIZE_URL,
      })
    : null;
}

const aiPaired = (config: { AI_API_KEY?: string; AI_MODEL?: string }) =>
  (config.AI_API_KEY === undefined) === (config.AI_MODEL === undefined);
const AI_PAIRED = { path: ['AI_MODEL'], message: 'Set both AI_API_KEY and AI_MODEL, or neither' };

const common = {
  NODE_ENV: env.nodeEnv(),
  LOG_LEVEL: env.logLevel(),
  /**
   * Where errors logged go too (ADR-743): a project's DSN on Hatti's own GlitchTip, the
   * open-source error tracker, or any that takes Sentry's protocol. Unset, none are sent.
   */
  ERROR_TRACKING_DSN: z
    .string()
    .refine((dsn) => {
      try {
        parseDsn(dsn);
        return true;
      } catch {
        return false;
      }
    }, 'Expected a DSN, such as https://<key>@errors.hatti.pk/<project>')
    .optional(),
  /** What the tracker files events under: "staging", "production"; NODE_ENV's by default. */
  ERROR_TRACKING_ENVIRONMENT: z.string().min(1).max(64).optional(),
  /** The release running, such as the image's tag, which the tracker groups events by. */
  ERROR_TRACKING_RELEASE: z.string().min(1).max(200).optional(),
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
    /**
     * Whether checkout offers Hatti Pass, shoppers' details for any Hatti shop (ADR-867). Off until
     * Hatti's privacy policy says Hatti keeps them (OWN-57).
     */
    HATTI_PASS: env.flag().default(false),
    /** GraphiQL at /graphiql. Defaults to on in development only. */
    GRAPHIQL: env.flag().optional(),
    /**
     * The Admin API's buckets of query cost (ADR-576): the points each app holds in each shop, and
     * how many it restores a second; and each member of staff's, from the admin. Apps get
     * Shopify's standard bucket, 1,000 restoring 50 a second, unless set. Staff get twice that:
     * the admin is Hatti's own client, a page of it asks several queries at once, and a person
     * clicking cannot drain a bucket as a script can.
     */
    ADMIN_API_APP_BUCKET_SIZE: z.coerce.number().int().min(1).default(1_000),
    ADMIN_API_APP_RESTORE_RATE: z.coerce.number().int().min(1).default(50),
    ADMIN_API_STAFF_BUCKET_SIZE: z.coerce.number().int().min(1).default(2_000),
    ADMIN_API_STAFF_RESTORE_RATE: z.coerce.number().int().min(1).default(100),
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
    STOREFRONT_DNS_TARGET: storefrontDnsTarget,
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
     * Embedded Signup (ADR-419), through which shops connect WhatsApp numbers of their own:
     * Hatti's Meta app's ID, whose secret is WHATSAPP_APP_SECRET, and the ID of the Facebook
     * Login for Business configuration it starts with. Both or neither; without them, shops
     * cannot connect numbers of their own.
     */
    WHATSAPP_APP_ID: z
      .string()
      .regex(/^[0-9]{5,30}$/, 'Expected digits')
      .optional(),
    WHATSAPP_SIGNUP_CONFIG_ID: z
      .string()
      .regex(/^[0-9]{5,30}$/, 'Expected digits')
      .optional(),
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
    /**
     * Hatti's own bank account, which shops pay invoices into by transfer or Raast (ADR-254): its
     * title and bank, as its bank shows them, and its IBAN, all three or none; and the number its
     * bank registered for Raast, if any. Without them, invoices are not paid by transfer.
     */
    BILLING_BANK_TITLE: z.string().trim().min(1).max(100).optional(),
    BILLING_BANK_NAME: z.string().trim().min(1).max(100).optional(),
    BILLING_BANK_IBAN: pkIban().optional(),
    BILLING_RAAST_ID: pkMobile().optional(),
    /**
     * Hatti's registration for sales tax on services (ADR-512): the revenue authority and Hatti's
     * number with it, both or neither; the rate, as a percentage, where it is not the authority's
     * standard one; and Hatti's NTN, printed on invoices. Without them, invoices carry no tax.
     */
    BILLING_TAX_AUTHORITY: z.enum(['PRA', 'SRB', 'KPRA', 'BRA', 'ICT']).optional(),
    BILLING_TAX_REGISTRATION: z.string().trim().min(1).max(40).optional(),
    BILLING_TAX_RATE: z.coerce.number().min(0).max(50).optional(),
    BILLING_NTN: z.string().trim().min(1).max(20).optional(),
    /**
     * Hatti's own support lines (ADR-508), shown to shops as their plans allow: the WhatsApp
     * number for Starter and above, a phone line for Pro, an email for all, and the hours Hatti's
     * people answer in, in English and Urdu, both or neither. Without them, shops send requests
     * from the admin alone.
     */
    SUPPORT_WHATSAPP: pkMobile().optional(),
    SUPPORT_PHONE: z
      .string()
      .transform((value) => value.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^\+92[0-9]{9,10}$/, 'Expected a Pakistani number: +924235761999'))
      .optional(),
    SUPPORT_EMAIL: z.string().trim().email().max(200).optional(),
    SUPPORT_HOURS: z.string().trim().min(1).max(100).optional(),
    SUPPORT_HOURS_UR: z.string().trim().min(1).max(100).optional(),
    ...supportWhatsApp,
    ...aiGateway,
    ...speechToText,
    ...daraz,
    /**
     * The map tiles checkout's map to move the address's pin on is drawn from (ADR-719): a
     * provider's raster tiles by a template with {z}, {x} and {y} after its host, such as
     * "https://tiles.example.com/{z}/{x}/{y}.png?key=…", and the words its terms ask maps to show,
     * such as "© OpenStreetMap contributors". Both or neither; without them, no map.
     */
    MAP_TILES_URL: z
      .string()
      .regex(
        /^https:\/\/[^/{}]+\/.*\{z\}/,
        'Expected an https URL with {z}, {x} and {y} after its host',
      )
      .optional(),
    MAP_TILES_ATTRIBUTION: z.string().trim().min(1).max(200).optional(),
    ...messageSending,
    ...tiktokApi,
    ...googleAds,
    ...storage,
    ...webPush,
  })
  .refine(webPushComplete, WEB_PUSH_COMPLETE)
  .refine(aiPaired, AI_PAIRED)
  .refine(darazPaired, DARAZ_PAIRED)
  .refine(
    (config) =>
      (config.MAP_TILES_URL === undefined) === (config.MAP_TILES_ATTRIBUTION === undefined),
    {
      path: ['MAP_TILES_ATTRIBUTION'],
      message: 'Set both MAP_TILES_URL and MAP_TILES_ATTRIBUTION, or neither',
    },
  )
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
      (config.WHATSAPP_APP_ID === undefined) === (config.WHATSAPP_SIGNUP_CONFIG_ID === undefined) &&
      (config.WHATSAPP_APP_ID === undefined || config.WHATSAPP_APP_SECRET !== undefined),
    {
      path: ['WHATSAPP_SIGNUP_CONFIG_ID'],
      message:
        'Set both WHATSAPP_APP_ID and WHATSAPP_SIGNUP_CONFIG_ID, with WHATSAPP_APP_SECRET, or neither',
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
  .refine(
    (config) =>
      new Set([
        config.BILLING_BANK_TITLE === undefined,
        config.BILLING_BANK_NAME === undefined,
        config.BILLING_BANK_IBAN === undefined,
      ]).size === 1,
    {
      path: ['BILLING_BANK_IBAN'],
      message: 'Set BILLING_BANK_TITLE, BILLING_BANK_NAME and BILLING_BANK_IBAN together, or none',
    },
  )
  .refine(
    (config) => (config.SUPPORT_HOURS === undefined) === (config.SUPPORT_HOURS_UR === undefined),
    {
      path: ['SUPPORT_HOURS_UR'],
      message: 'Set both SUPPORT_HOURS and SUPPORT_HOURS_UR, or neither',
    },
  )
  .refine(supportWhatsAppPaired, SUPPORT_WHATSAPP_PAIRED)
  .refine(googleAdsComplete, GOOGLE_ADS_COMPLETE)
  .refine(
    (config) =>
      config.SUPPORT_WHATSAPP_PHONE_NUMBER_ID === undefined ||
      config.SUPPORT_WHATSAPP_PHONE_NUMBER_ID !== config.WHATSAPP_PHONE_NUMBER_ID,
    {
      path: ['SUPPORT_WHATSAPP_PHONE_NUMBER_ID'],
      message: "Must not be the shared notifications number: customers' replies come to it",
    },
  )
  .refine(
    (config) =>
      (config.BILLING_TAX_AUTHORITY === undefined) ===
        (config.BILLING_TAX_REGISTRATION === undefined) &&
      (config.BILLING_TAX_RATE === undefined || config.BILLING_TAX_AUTHORITY !== undefined),
    {
      path: ['BILLING_TAX_REGISTRATION'],
      message:
        'Set both BILLING_TAX_AUTHORITY and BILLING_TAX_REGISTRATION, or neither; ' +
        'BILLING_TAX_RATE only with them',
    },
  )
  .refine(
    (config) => config.BILLING_RAAST_ID === undefined || config.BILLING_BANK_IBAN !== undefined,
    {
      path: ['BILLING_RAAST_ID'],
      message: "Set Hatti's account with BILLING_BANK_IBAN first: Raast pays into it",
    },
  )
  .refine(storageComplete, STORAGE_COMPLETE)
  .refine(storageShared, STORAGE_SHARED)
  .refine(whatsAppPaired, WHATSAPP_PAIRED)
  .refine(smsPaired, SMS_PAIRED)
  .refine(voiceComplete, VOICE_COMPLETE)
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

/** The Admin API's buckets of query cost, for apps and for staff (ADR-576). */
export function queryCostLimitsOf(
  config: Pick<
    ApiConfig,
    | 'ADMIN_API_APP_BUCKET_SIZE'
    | 'ADMIN_API_APP_RESTORE_RATE'
    | 'ADMIN_API_STAFF_BUCKET_SIZE'
    | 'ADMIN_API_STAFF_RESTORE_RATE'
  >,
): QueryCostLimits {
  return {
    app: {
      maximum: config.ADMIN_API_APP_BUCKET_SIZE,
      restoreRate: config.ADMIN_API_APP_RESTORE_RATE,
    },
    staff: {
      maximum: config.ADMIN_API_STAFF_BUCKET_SIZE,
      restoreRate: config.ADMIN_API_STAFF_RESTORE_RATE,
    },
  };
}

/** An address the worker checks for one of Hatti's parts (ADR-536). */
export interface StatusProbe {
  component: StatusComponent;
  url: string;
}

/** "part=address" pairs, comma-separated; null if one is not, or names no part. */
export function statusProbesOf(value: string): StatusProbe[] | null {
  const probes: StatusProbe[] = [];
  for (const pair of value
    .split(',')
    .map((each) => each.trim())
    .filter(Boolean)) {
    const at = pair.indexOf('=');
    const component = pair.slice(0, at).trim() as StatusComponent;
    const url = pair.slice(at + 1).trim();
    if (at < 1 || !STATUS_COMPONENTS.includes(component) || !/^https?:\/\/\S+$/.test(url)) {
      return null;
    }
    probes.push({ component, url });
  }
  return probes;
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
    /**
     * Whether the sweep deletes closed shops' data 90 days after they closed, but the records kept
     * (ADR-741). Off until counsel confirms what is kept (OWN-41); Hatti's people may purge one
     * shop meanwhile, with `closed-shops`.
     */
    CLOSED_SHOP_PURGE: env.flag().default(false),
    /**
     * How often articles and pages published at a time ahead are shown once it comes (ADR-215,
     * ADR-217), and shops' broadcasts queued once theirs does (ADR-422).
     */
    SCHEDULED_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
    /** How often apps' webhooks due are posted (ADR-397). */
    WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
    /**
     * For development alone: lets webhooks go to plain http and private addresses, such as a
     * server on this machine. Never set it in production.
     */
    WEBHOOK_PRIVATE_ADDRESSES: env.flag().default(false),
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
     * Where shops point domains of their own, as the API's: the domain checks ask DNS whether they
     * still do (ADR-262).
     */
    STOREFRONT_DNS_TARGET: storefrontDnsTarget,
    /**
     * The API's public address, as its PUBLIC_URL: messages link customers' order pages there
     * (ADR-147). Required in production; http://localhost:4000 otherwise.
     */
    PUBLIC_URL: env.httpUrl().optional(),
    ...tiktokApi,
    ...googleAds,
    /** Google Analytics, which shops' orders go to through its Measurement Protocol (ADR-547). */
    GOOGLE_ANALYTICS_URL: env.httpUrl().default('https://www.google-analytics.com'),
    /** How often the moments of orders due go to the ad platforms. */
    CONVERSIONS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
    /**
     * How often shops' spend is pulled from the Meta ad accounts (ADR-564) and TikTok advertiser
     * accounts (ADR-566) they connected: every three hours, the last week's each time.
     */
    AD_SPEND_SYNC_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(3 * 60 * 60_000),
    /** FBR's IMS, which Tier-1 shops' POS report their invoices to (ADR-555). */
    FBR_POS_URL: env.httpUrl().default('https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData'),
    /** FBR's sandbox of it, for shops trying their POS. */
    FBR_POS_SANDBOX_URL: env
      .httpUrl()
      .default('https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData'),
    /** FBR's digital invoicing, which shops registered for sales tax report through (ADR-562). */
    FBR_DI_URL: env.httpUrl().default(FBR_DI_URLS.production),
    /** FBR's sandbox of it, for shops proving FBR's scenarios. */
    FBR_DI_SANDBOX_URL: env.httpUrl().default(FBR_DI_URLS.sandbox),
    /** How often invoices due go to FBR. */
    FISCAL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
    /** How often messages due go out. */
    MESSAGES_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    /** PostEx's merchant API, which its bookings go to (ADR-149). */
    POSTEX_URL: env.httpUrl().default('https://api.postex.pk/services/integration/api/order'),
    /** Leopards' merchant API, which its bookings go to (ADR-162); its staging API in tests. */
    LEOPARDS_URL: env.httpUrl().default('https://merchantapi.leopardscourier.com/api'),
    /** TCS's COD API, which its bookings go to (ADR-509); its sandbox in tests. */
    TCS_URL: env.httpUrl().default('https://api.tcscourier.com/production/v1/cod'),
    /** Trax's merchant API, which its bookings go to (ADR-510). */
    TRAX_URL: env.httpUrl().default('https://sonic.pk/api'),
    /** How often bookings due are booked with couriers, and parcels due are asked about. */
    COURIER_BOOKINGS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
    /** How often products' images due are made ready, and those of media gone removed. */
    IMAGES_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    /** How often products' videos ready are made at smaller sizes (ADR-791). */
    VIDEO_SIZES_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
    /** The ffmpeg program the worker makes them with: `ffmpeg` on the PATH unless given. */
    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    /** How often the storefronts' counts of each day's sessions are kept (ADR-180). */
    SESSIONS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
    /** How often storefronts whose publisher gave up are built, once they go quiet (ADR-225). */
    STOREFRONTS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
    /**
     * The open currency feed the day's rates come from (ADR-865), units of each currency for one
     * rupee: Fawaz Ahmed's exchange API, free and its data in the public domain, from jsDelivr's
     * CDN.
     */
    CURRENCY_FEED_URL: env
      .httpUrl()
      .default(
        'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/pkr.json',
      ),
    /** How often the feed is read: its rates change once a day. */
    CURRENCY_RATES_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(6 * 3_600_000),
    /**
     * Hatti's support address (ADR-508), which is told of shops' requests still open past their
     * plan's time (ADR-525). Without it, they are logged alone.
     */
    SUPPORT_EMAIL: z.string().trim().email().max(200).optional(),
    /**
     * Addresses the worker checks for each of Hatti's parts, posting an incident on the status
     * page when one stops answering (ADR-536): "storefronts=https://demo.hatti.pk/,
     * admin=https://admin.hatti.pk/health". Without it, nothing is checked.
     */
    STATUS_PROBES: z
      .string()
      .trim()
      .max(2_000)
      .optional()
      .transform((value, context) => {
        const probes = statusProbesOf(value ?? '');
        if (probes === null) {
          context.addIssue({
            code: 'custom',
            message: `Give part=https://address pairs, the parts of: ${STATUS_COMPONENTS.join(', ')}`,
          });
          return z.NEVER;
        }
        return probes;
      }),
    ...messageSending,
    ...aiGateway,
    ...speechToText,
    ...daraz,
    /** How often each shop's Daraz account is synced (ADR-875). */
    DARAZ_SYNC_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(10 * 60_000),
    ...storage,
    ...webPush,
  })
  .refine(aiPaired, AI_PAIRED)
  .refine(darazPaired, DARAZ_PAIRED)
  .refine(webPushComplete, WEB_PUSH_COMPLETE)
  .refine(whatsAppPaired, WHATSAPP_PAIRED)
  .refine(smsPaired, SMS_PAIRED)
  .refine(voiceComplete, VOICE_COMPLETE)
  .refine(sesComplete, SES_COMPLETE)
  .refine(googleAdsComplete, GOOGLE_ADS_COMPLETE)
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

/** Hatti's people pay partners their share (ADR-505), with the identity login, as for agents. */
const partnerPayoutsSchema = supportAgentSchema;

/**
 * Hatti's people list the transfers shops said they made into Hatti's account, and confirm or
 * refuse each (ADR-254), with the app login and the system login, which finds them across shops.
 */
const billingTransfersSchema = z.object({
  DATABASE_URL: env.postgresUrl(),
  DATABASE_SYSTEM_URL: env.postgresUrl(),
  /** Where the API answers; invoices' pages are there. */
  PUBLIC_URL: env.httpUrl().optional(),
});

/**
 * Hatti's people see the closed shops whose data is due to go, and purge one (ADR-741), with the
 * system login, which reads and deletes every shop's, and the storage its files are in.
 */
const closedShopsSchema = z
  .object({
    ...storage,
    DATABASE_URL: env.postgresUrl(),
    DATABASE_SYSTEM_URL: env.postgresUrl(),
  })
  .refine(storageComplete, STORAGE_COMPLETE);

/**
 * Hatti's people answer shops' support requests (ADR-508) with the app login and the system login,
 * which finds them across shops; and on WhatsApp, from Hatti's support number on Meta's Graph API,
 * those its staff wrote about there (ADR-560), where it is set up.
 */
const supportRequestsSchema = z
  .object({
    DATABASE_URL: env.postgresUrl(),
    DATABASE_SYSTEM_URL: env.postgresUrl(),
    META_GRAPH_URL: messageSending.META_GRAPH_URL,
    META_GRAPH_VERSION: messageSending.META_GRAPH_VERSION,
    ...supportWhatsApp,
  })
  .refine(supportWhatsAppPaired, SUPPORT_WHATSAPP_PAIRED);

/**
 * Hatti's people decide on shoppers' reports of stores (ADR-460) and shops' verifications (ADR-465),
 * with the system login, which reads every shop's.
 */
const trustReportsSchema = z
  .object({
    DATABASE_URL: env.postgresUrl(),
    DATABASE_SYSTEM_URL: env.postgresUrl(),
    /**
     * The core's public address, where a takedown's link to appeal by goes (ADR-462): needed to
     * take a store down. Local storage's links to verifications' documents go there too.
     */
    PUBLIC_URL: env.httpUrl().optional(),
    // Where verifications' documents are kept, as the API keeps them (ADR-465).
    ...storage,
  })
  .refine(storageComplete, STORAGE_COMPLETE);

/**
 * Hatti's people review couriers' names for cities across shops, and keep Hatti's own (ADR-260),
 * with the system login, which reads every shop's.
 */
const courierCitiesSchema = z.object({
  DATABASE_URL: env.postgresUrl(),
  DATABASE_SYSTEM_URL: env.postgresUrl(),
});

/**
 * Hatti's people post incidents and maintenance to Hatti's status page (ADR-498) with the system
 * login, the only one that writes them.
 */
const statusIncidentsSchema = z.object({
  DATABASE_URL: env.postgresUrl(),
  DATABASE_SYSTEM_URL: env.postgresUrl(),
});

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

/**
 * Whoever runs Hatti sets the bucket's CORS rule for the admin's uploads (ADR-733): the bucket
 * through the S3 API, and where staff use the admin.
 */
const storageCorsSchema = z
  .object({
    ...storage,
    STORAGE_DRIVER: z.literal('s3'),
    /** Where staff use the admin, whose browsers upload straight to the bucket (ADR-268). */
    ADMIN_URL: env.httpUrl(),
  })
  .refine(storageComplete, STORAGE_COMPLETE);

export type ApiConfig = z.output<typeof apiSchema>;
export type WorkerConfig = z.output<typeof workerSchema>;
export type SeedConfig = z.output<typeof seedSchema>;
export type SupportAgentConfig = z.output<typeof supportAgentSchema>;
export type PartnerPayoutsConfig = z.output<typeof partnerPayoutsSchema>;
export type EmailSuppressionConfig = z.output<typeof emailSuppressionSchema>;
export type BillingTransfersConfig = z.output<typeof billingTransfersSchema>;
export type SupportRequestsConfig = z.output<typeof supportRequestsSchema>;
export type CourierCitiesConfig = z.output<typeof courierCitiesSchema>;
export type TrustReportsConfig = z.output<typeof trustReportsSchema>;
export type StatusIncidentsConfig = z.output<typeof statusIncidentsSchema>;
export type StorageCorsConfig = z.output<typeof storageCorsSchema>;
export type ClosedShopsConfig = z.output<typeof closedShopsSchema>;

export const loadApiConfig = (source?: Env): ApiConfig => parseEnv(apiSchema, source);
export const loadWorkerConfig = (source?: Env): WorkerConfig => parseEnv(workerSchema, source);
export const loadSeedConfig = (source?: Env): SeedConfig => parseEnv(seedSchema, source);
export const loadSupportAgentConfig = (source?: Env): SupportAgentConfig =>
  parseEnv(supportAgentSchema, source);
export const loadPartnerPayoutsConfig = (source?: Env): PartnerPayoutsConfig =>
  parseEnv(partnerPayoutsSchema, source);
export const loadEmailSuppressionConfig = (source?: Env): EmailSuppressionConfig =>
  parseEnv(emailSuppressionSchema, source);
export const loadBillingTransfersConfig = (source?: Env): BillingTransfersConfig =>
  parseEnv(billingTransfersSchema, source);
export const loadSupportRequestsConfig = (source?: Env): SupportRequestsConfig =>
  parseEnv(supportRequestsSchema, source);
export const loadCourierCitiesConfig = (source?: Env): CourierCitiesConfig =>
  parseEnv(courierCitiesSchema, source);
export const loadTrustReportsConfig = (source?: Env): TrustReportsConfig =>
  parseEnv(trustReportsSchema, source);
export const loadStatusIncidentsConfig = (source?: Env): StatusIncidentsConfig =>
  parseEnv(statusIncidentsSchema, source);
export const loadStorageCorsConfig = (source?: Env): StorageCorsConfig =>
  parseEnv(storageCorsSchema, source);
export const loadClosedShopsConfig = (source?: Env): ClosedShopsConfig =>
  parseEnv(closedShopsSchema, source);
