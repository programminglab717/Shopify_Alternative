import type { AiGateway } from '@hatti/ai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DnsLookup } from '@hatti/api';
import type {
  HattiBankAccount,
  HattiGateway,
  HattiTax,
  SupportContact,
} from '@hatti/billing/public';
import type { AccountEmails, GoogleSignInSettings, PhoneCodeSender } from '@hatti/identity/public';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import type { TestDatabase } from '@hatti/db/testing';
import { createLogger } from '@hatti/logger';
import type {
  SupportLineSettings,
  VapidKeys,
  WhatsAppReplySettings,
  WhatsAppSignupSettings,
  WhatsAppWebhookSettings,
} from '@hatti/messaging/public';
import type { GoogleAdsOptions, MetaGraphOptions, TikTokApiOptions } from '@hatti/marketing/public';
import type { PaymentGateways } from '@hatti/payments/public';
import { LocalStorage } from '@hatti/storage';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { createApi } from '../api/create-api.js';
import type { QueryCostOptions } from '../api/query-cost.js';
import { couriersOf } from '../couriers.js';
import { hattiGatewayOf } from '../billing.js';
import { paymentGatewaysOf } from '../payments.js';

export interface TestApi {
  app: NestFastifyApplication;
  database: Database;
  /** Files, in a directory of the test's own, served at http://localhost:4000/storage. */
  storage: LocalStorage;
  close(): Promise<void>;
}

/** What storefronts present to the /storefront/ routes in tests. */
export const TEST_STOREFRONT_KEY = 'test-storefront-key-with-32-characters';

/** Hatti's own bank account in tests (ADR-254), which shops pay invoices into by transfer. */
export const TEST_HATTI_BANK_ACCOUNT: HattiBankAccount = {
  title: 'Hatti Technologies (Private) Limited',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
  raastId: '+923001234567',
};

/** Where tests' staff sign in with passkeys: the admin at http://localhost:4000. */
export const TEST_PASSKEYS = {
  rpId: 'localhost',
  rpName: 'Hatti',
  origins: ['http://localhost:4000'],
};

/**
 * Boots the Admin API against a test database, with quiet logs and no rate limits, DNS that
 * knows nothing unless the test gives its own, files kept in a directory of its own, WhatsApp's
 * webhook where the test sets it up, and the test's payment gateways if it gives them.
 */
export async function startTestApi(
  testDb: TestDatabase,
  options: {
    dns?: DnsLookup;
    whatsapp?: WhatsAppWebhookSettings;
    /** Hatti's Meta app and Embedded Signup's configuration (ADR-419); none unless given. */
    whatsAppSignup?: WhatsAppSignupSettings;
    /** Meta's Graph API as the inbox answers customers (ADR-546); none unless given. */
    whatsAppReplies?: WhatsAppReplySettings;
    /** Meta's Graph API as shops' ad accounts are read (ADR-564); Meta's own unless given. */
    metaGraph?: MetaGraphOptions;
    /** TikTok's Business API as shops' advertisers are read (ADR-566); TikTok's unless given. */
    tiktokApi?: TikTokApiOptions;
    /** The Google Ads API and Google's OAuth (ADR-678); Google's, with no credentials, unless given. */
    googleAds?: GoogleAdsOptions;
    paymentGateways?: PaymentGateways;
    /** Hatti's own gateway account (ADR-154); the test gateway unless given, or null for none. */
    billingGateway?: HattiGateway | null;
    /**
     * Hatti's own bank account (ADR-254); {@link TEST_HATTI_BANK_ACCOUNT} unless given, or null
     * for none.
     */
    billingBankAccount?: HattiBankAccount | null;
    /** Hatti's registration for sales tax on services (ADR-512); none unless given. */
    billingTax?: HattiTax | null;
    /** Hatti's own support lines (ADR-508); none unless given. */
    support?: SupportContact | null;
    /** Hatti's support WhatsApp number (ADR-560); none unless given. */
    supportLine?: SupportLineSettings;
    /** Where merchants' sign-in codes go (ADR-159); without it, no one signs in by phone. */
    phoneCodes?: PhoneCodeSender;
    /** Hatti's client IDs and Google's keys (ADR-164); without them, no one signs in with Google. */
    google?: GoogleSignInSettings;
    /** Where Hatti's emails about accounts go (ADR-165); without it, none are sent. */
    emails?: AccountEmails;
    /** Valkey, where storefronts count their sessions (ADR-180); without it, none are read. */
    redis?: Redis;
    /** The AI gateway (ADR-463); without it, nothing is drafted with AI. */
    ai?: AiGateway;
    /** Hatti's VAPID keys (ADR-506); without them, nothing is pushed to staff's browsers. */
    push?: VapidKeys;
    /** How queries are costed and throttled (ADR-576); without it, none is. */
    queryCost?: QueryCostOptions;
  } = {},
): Promise<TestApi> {
  const database = new Database({ appUrl: testDb.appUrl, applicationName: 'api-test' });
  const identityDatabase = new Database({
    appUrl: testDb.identityUrl,
    applicationName: 'api-test:identity',
  });
  const directory = await mkdtemp(join(tmpdir(), 'hatti-api-files-'));
  const storage = new LocalStorage({
    directory,
    baseUrl: 'http://localhost:4000/storage',
    secret: 'test-storage-secret-of-32-characters',
  });
  const app = await createApi({
    database,
    storage,
    redis: options.redis ?? null,
    ai: options.ai ?? null,
    logger: createLogger({ name: 'api-test', level: 'silent' }),
    identity: {
      db: identityDatabase.app,
      secretBox: new SecretBox([{ id: 'test', key: Buffer.alloc(32, 9) }]),
      passkeys: TEST_PASSKEYS,
      phoneCodes: options.phoneCodes ?? null,
      google: options.google ?? null,
      emails: options.emails ?? null,
    },
    maskInternalErrors: true,
    storefrontKey: TEST_STOREFRONT_KEY,
    dnsLookup: options.dns ?? new TestDns(),
    whatsapp: options.whatsapp ?? null,
    whatsAppSignup: options.whatsAppSignup ?? null,
    whatsAppReplies: options.whatsAppReplies ?? null,
    ...(options.metaGraph && { metaGraph: options.metaGraph }),
    ...(options.tiktokApi && { tiktokApi: options.tiktokApi }),
    ...(options.googleAds && { googleAds: options.googleAds }),
    push: options.push ?? null,
    queryCost: options.queryCost ?? null,
    couriers: couriersOf({ production: false }),
    paymentGateways: options.paymentGateways ?? paymentGatewaysOf({ production: false }),
    billingGateway:
      options.billingGateway === undefined
        ? hattiGatewayOf({ NODE_ENV: 'test', BILLING_SAFEPAY_ENVIRONMENT: 'production' })
        : options.billingGateway,
    billingBankAccount:
      options.billingBankAccount === undefined
        ? TEST_HATTI_BANK_ACCOUNT
        : options.billingBankAccount,
    billingTax: options.billingTax ?? null,
    support: options.support ?? null,
    supportLine: options.supportLine ?? null,
  });
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    database,
    storage,
    async close() {
      await app.close();
      await database.close();
      await identityDatabase.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** DNS for tests: the records a test sets, and nothing else. */
export class TestDns extends DnsLookup {
  readonly records = new Map<string, { cnames?: string[]; addresses?: string[] }>();

  async cnames(host: string): Promise<string[]> {
    return this.records.get(host)?.cnames ?? [];
  }

  async addresses(host: string): Promise<string[]> {
    return this.records.get(host)?.addresses ?? [];
  }
}
