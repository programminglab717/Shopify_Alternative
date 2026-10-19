import { SecretBox } from '@hatti/crypto';
import { describe, expect, it } from 'vitest';
import {
  hattiBankAccountOf,
  hattiGatewayOf,
  hattiTaxOf,
  supportContactOf,
  supportLineOf,
  supportSenderOf,
} from './billing.js';
import {
  loadApiConfig,
  loadBillingTransfersConfig,
  loadSupportRequestsConfig,
  loadWorkerConfig,
  passkeysOf,
  queryCostLimitsOf,
  vapidKeysOf,
} from './config.js';

const KEY = 'k'.repeat(32);

/** Files in R2, as production must keep them. */
const R2 = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'hatti-files',
  S3_ACCESS_KEY_ID: 'AKID',
  S3_SECRET_ACCESS_KEY: 's'.repeat(40),
};

const env = {
  DATABASE_URL: 'postgres://hatti_app:secret@localhost:5432/hatti',
  DATABASE_IDENTITY_URL: 'postgres://hatti_identity:secret@localhost:5432/hatti',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEYS: 'dev:w4lOEQUUBA6nkQTf84p2hmgomQTEky6Cs68n+7oqATw=',
};

describe('API configuration', () => {
  it('needs the public URL in production, where it goes into links sent to customers', () => {
    expect(() => loadApiConfig({ ...env, NODE_ENV: 'production' })).toThrow(
      'PUBLIC_URL: Required in production: links sent to customers point there',
    );
    const production = loadApiConfig({
      ...env,
      ...R2,
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://hatti.pk',
      STOREFRONT_URL: 'https://hatti.pk',
      STOREFRONT_SERVICE_KEY: KEY,
    });
    expect(production.PUBLIC_URL).toBe('https://hatti.pk');
    // Elsewhere the API serves its own links, at http://localhost:PORT.
    expect(loadApiConfig(env).PUBLIC_URL).toBeUndefined();
    expect(() => loadApiConfig({ ...env, PUBLIC_URL: 'ftp://hatti.pk' })).toThrow(/PUBLIC_URL/);
  });

  it("keeps staff's passkeys to the public URL's host unless told, and origins under it", () => {
    expect(passkeysOf(loadApiConfig(env))).toEqual({
      rpId: 'localhost',
      rpName: 'Hatti',
      origins: ['http://localhost:4000'],
    });
    expect(passkeysOf(loadApiConfig({ ...env, PUBLIC_URL: 'https://hatti.pk/' }))).toMatchObject({
      rpId: 'hatti.pk',
      origins: ['https://hatti.pk'],
    });
    const admin = loadApiConfig({
      ...env,
      PUBLIC_URL: 'https://hatti.pk',
      PASSKEY_RP_ID: 'hatti.pk',
      PASSKEY_ORIGINS: 'https://admin.hatti.pk, https://hatti.pk',
    });
    expect(passkeysOf(admin).origins).toEqual(['https://admin.hatti.pk', 'https://hatti.pk']);
    expect(() =>
      loadApiConfig({ ...env, PASSKEY_RP_ID: 'hatti.pk', PASSKEY_ORIGINS: 'https://evil.pk' }),
    ).toThrow(
      'PASSKEY_ORIGINS: Each origin must be on PASSKEY_RP_ID or under it, as WebAuthn asks',
    );
    expect(() => loadApiConfig({ ...env, PASSKEY_RP_ID: 'https://hatti.pk' })).toThrow(
      /PASSKEY_RP_ID/,
    );
  });

  it("takes Amazon SES's region and key together, or none of them (ADR-165)", () => {
    const ses = {
      SES_REGION: 'ap-southeast-1',
      SES_ACCESS_KEY_ID: 'AKIAHATTITEST0000001',
      SES_SECRET_ACCESS_KEY: 's'.repeat(40),
    };
    expect(loadApiConfig({ ...env, ...ses })).toMatchObject({
      ...ses,
      EMAIL_FROM: 'Hatti <no-reply@hatti.pk>',
    });
    expect(() => loadApiConfig({ ...env, ...ses, SES_SECRET_ACCESS_KEY: undefined })).toThrow(
      'SES_SECRET_ACCESS_KEY: Set SES_REGION, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY together, or none',
    );
    expect(() => loadApiConfig({ ...env, ...ses, SES_REGION: 'Singapore' })).toThrow(
      'SES_REGION: Expected an AWS region, like ap-southeast-1',
    );
    // Its bounces and complaints come through a topic of SNS's, beside SES's own settings (ADR-170).
    const topic = 'arn:aws:sns:ap-southeast-1:123456789012:hatti-ses-feedback';
    expect(
      loadApiConfig({ ...env, ...ses, SES_FEEDBACK_TOPIC_ARN: topic }).SES_FEEDBACK_TOPIC_ARN,
    ).toBe(topic);
    expect(() => loadApiConfig({ ...env, SES_FEEDBACK_TOPIC_ARN: topic })).toThrow(
      "SES_FEEDBACK_TOPIC_ARN: Set SES's own settings too: the topic tells of the emails SES sends",
    );
    expect(() =>
      loadApiConfig({ ...env, ...ses, SES_FEEDBACK_TOPIC_ARN: 'hatti-ses-feedback' }),
    ).toThrow(/SES_FEEDBACK_TOPIC_ARN: Expected an SNS topic ARN/);
  });

  it("takes Hatti's client IDs at Google, the admin's first, or none (ADR-164)", () => {
    expect(loadApiConfig(env).GOOGLE_CLIENT_IDS).toBeUndefined();
    expect(
      loadApiConfig({
        ...env,
        GOOGLE_CLIENT_IDS:
          '123-admin.apps.googleusercontent.com, 123-android.apps.googleusercontent.com',
      }).GOOGLE_CLIENT_IDS,
    ).toEqual(['123-admin.apps.googleusercontent.com', '123-android.apps.googleusercontent.com']);
    // Its secret is not one.
    expect(() => loadApiConfig({ ...env, GOOGLE_CLIENT_IDS: 'GOCSPX-abc123' })).toThrow(
      'GOOGLE_CLIENT_IDS.0: Expected client IDs Google gave, ending .apps.googleusercontent.com',
    );
  });

  it("needs the storefronts' address in production, where merchants are shown them", () => {
    expect(() =>
      loadApiConfig({ ...env, NODE_ENV: 'production', PUBLIC_URL: 'https://hatti.pk' }),
    ).toThrow(
      'STOREFRONT_URL: Required in production: merchants are shown their storefronts there',
    );
    // Elsewhere storefronts answer at http://{handle}.localhost:4100.
    expect(loadApiConfig(env).STOREFRONT_URL).toBeUndefined();
  });

  it("needs the storefronts' key in production, which storefronts reach carts with", () => {
    const production = {
      ...env,
      ...R2,
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://hatti.pk',
      STOREFRONT_URL: 'https://hatti.pk',
    };
    expect(() => loadApiConfig(production)).toThrow(
      "STOREFRONT_SERVICE_KEY: Required in production: storefronts keep shoppers' carts through it",
    );
    expect(() => loadApiConfig({ ...production, STOREFRONT_SERVICE_KEY: 'short' })).toThrow(
      /STOREFRONT_SERVICE_KEY/,
    );
    expect(
      loadApiConfig({ ...production, STOREFRONT_SERVICE_KEY: KEY }).STOREFRONT_SERVICE_KEY,
    ).toBe(KEY);
    // Elsewhere it may be left out, and the /storefront/ routes are not served.
    expect(loadApiConfig(env).STOREFRONT_SERVICE_KEY).toBeUndefined();
  });

  it('keeps files in a bucket in production, and in a directory elsewhere', () => {
    const production = {
      ...env,
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://hatti.pk',
      STOREFRONT_URL: 'https://hatti.pk',
      STOREFRONT_SERVICE_KEY: KEY,
    };
    expect(() => loadApiConfig(production)).toThrow(
      "STORAGE_DRIVER: Must be s3 in production: a local directory is one machine's",
    );
    expect(() => loadApiConfig({ ...production, STORAGE_DRIVER: 's3' })).toThrow(
      'STORAGE_DRIVER: Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for s3',
    );
    expect(loadApiConfig({ ...production, ...R2 })).toMatchObject({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'hatti-files',
      S3_REGION: 'auto',
    });
    expect(loadApiConfig(env)).toMatchObject({
      STORAGE_DRIVER: 'local',
      STORAGE_DIRECTORY: '.storage',
    });
  });

  it("takes WhatsApp's app secret and verify token together, or neither (ADR-146)", () => {
    expect(loadApiConfig(env).WHATSAPP_APP_SECRET).toBeUndefined();
    expect(() => loadApiConfig({ ...env, WHATSAPP_APP_SECRET: 'a'.repeat(32) })).toThrow(
      'WHATSAPP_VERIFY_TOKEN: Set both WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN, or neither',
    );
    expect(
      loadApiConfig({
        ...env,
        WHATSAPP_APP_SECRET: 'a'.repeat(32),
        WHATSAPP_VERIFY_TOKEN: 'v'.repeat(24),
      }),
    ).toMatchObject({ WHATSAPP_APP_SECRET: 'a'.repeat(32), WHATSAPP_VERIFY_TOKEN: 'v'.repeat(24) });
  });

  it("takes Embedded Signup's app and configuration together, with the app's secret (ADR-419)", () => {
    const webhook = { WHATSAPP_APP_SECRET: 'a'.repeat(32), WHATSAPP_VERIFY_TOKEN: 'v'.repeat(24) };
    const message =
      'WHATSAPP_SIGNUP_CONFIG_ID: Set both WHATSAPP_APP_ID and WHATSAPP_SIGNUP_CONFIG_ID, with ' +
      'WHATSAPP_APP_SECRET, or neither';
    expect(() => loadApiConfig({ ...env, ...webhook, WHATSAPP_APP_ID: '1234567890' })).toThrow(
      message,
    );
    expect(() =>
      loadApiConfig({ ...env, WHATSAPP_APP_ID: '1234567890', WHATSAPP_SIGNUP_CONFIG_ID: '98765' }),
    ).toThrow(message);
    expect(
      loadApiConfig({
        ...env,
        ...webhook,
        WHATSAPP_APP_ID: '1234567890',
        WHATSAPP_SIGNUP_CONFIG_ID: '987654321',
      }),
    ).toMatchObject({ WHATSAPP_APP_ID: '1234567890', WHATSAPP_SIGNUP_CONFIG_ID: '987654321' });
  });

  it("takes Hatti's own Safepay account whole or not at all, and the test gateway outside production (ADR-154)", () => {
    const local = loadApiConfig(env);
    expect(hattiGatewayOf(local)?.gateway.info.gateway).toBe('test');
    expect(() => loadApiConfig({ ...env, BILLING_SAFEPAY_API_KEY: 'sec_hatti' })).toThrow(
      'BILLING_SAFEPAY_WEBHOOK_SECRET: Set BILLING_SAFEPAY_API_KEY, BILLING_SAFEPAY_SECRET_KEY ' +
        'and BILLING_SAFEPAY_WEBHOOK_SECRET together, or none of them',
    );
    const safepay = loadApiConfig({
      ...env,
      BILLING_SAFEPAY_API_KEY: 'sec_hatti',
      BILLING_SAFEPAY_SECRET_KEY: 's'.repeat(32),
      BILLING_SAFEPAY_WEBHOOK_SECRET: 'w'.repeat(32),
      BILLING_SAFEPAY_ENVIRONMENT: 'sandbox',
    });
    expect(hattiGatewayOf(safepay)).toMatchObject({
      gateway: { info: { gateway: 'safepay' } },
      account: { environment: 'sandbox', credentials: { apiKey: 'sec_hatti' } },
    });
    // In production without it: invoices are not paid online.
    expect(hattiGatewayOf({ ...local, NODE_ENV: 'production' })).toBeNull();
  });

  it("takes Hatti's own bank account whole or not at all, its IBAN and Raast ID checked (ADR-254)", () => {
    // Without it, invoices are not paid by transfer.
    expect(hattiBankAccountOf(loadApiConfig(env))).toBeNull();
    const bank = {
      BILLING_BANK_TITLE: ' Hatti Technologies (Private) Limited ',
      BILLING_BANK_NAME: 'Standard Chartered',
      BILLING_BANK_IBAN: 'pk36 scbl 0000 0011 2345 6702',
    };
    expect(
      hattiBankAccountOf(loadApiConfig({ ...env, ...bank, BILLING_RAAST_ID: '0300-1234567' })),
    ).toEqual({
      title: 'Hatti Technologies (Private) Limited',
      bankName: 'Standard Chartered',
      iban: 'PK36SCBL0000001123456702',
      raastId: '+923001234567',
    });
    expect(hattiBankAccountOf(loadApiConfig({ ...env, ...bank }))?.raastId).toBeNull();
    expect(() => loadApiConfig({ ...env, BILLING_BANK_IBAN: bank.BILLING_BANK_IBAN })).toThrow(
      'BILLING_BANK_IBAN: Set BILLING_BANK_TITLE, BILLING_BANK_NAME and BILLING_BANK_IBAN ' +
        'together, or none',
    );
    expect(() =>
      loadApiConfig({ ...env, ...bank, BILLING_BANK_IBAN: 'PK36SCBL0000001123456703' }),
    ).toThrow('BILLING_BANK_IBAN: Expected a Pakistani IBAN');
    expect(() => loadApiConfig({ ...env, ...bank, BILLING_RAAST_ID: '042-111-222-333' })).toThrow(
      'BILLING_RAAST_ID: Expected a Pakistani mobile number',
    );
    expect(() => loadApiConfig({ ...env, BILLING_RAAST_ID: '03001234567' })).toThrow(
      "BILLING_RAAST_ID: Set Hatti's account with BILLING_BANK_IBAN first",
    );
  });

  it("takes Hatti's registration for sales tax whole or not at all, at its authority's rate unless given (ADR-512)", () => {
    expect(hattiTaxOf(loadApiConfig(env))).toBeNull();
    const registered = { BILLING_TAX_AUTHORITY: 'PRA', BILLING_TAX_REGISTRATION: ' P7654321-0 ' };
    expect(hattiTaxOf(loadApiConfig({ ...env, ...registered, BILLING_NTN: '1234567-8' }))).toEqual({
      authority: 'PRA',
      registration: 'P7654321-0',
      rate: 1600,
      ntn: '1234567-8',
    });
    expect(
      hattiTaxOf(
        loadApiConfig({
          ...env,
          ...registered,
          BILLING_TAX_AUTHORITY: 'SRB',
          BILLING_TAX_RATE: '8',
        }),
      ),
    ).toMatchObject({ authority: 'SRB', rate: 800, ntn: null });
    expect(() => loadApiConfig({ ...env, BILLING_TAX_AUTHORITY: 'PRA' })).toThrow(
      'BILLING_TAX_REGISTRATION: Set both BILLING_TAX_AUTHORITY and BILLING_TAX_REGISTRATION',
    );
    expect(() => loadApiConfig({ ...env, BILLING_TAX_RATE: '16' })).toThrow(
      'BILLING_TAX_RATE only',
    );
    expect(() => loadApiConfig({ ...env, ...registered, BILLING_TAX_AUTHORITY: 'FBR' })).toThrow(
      'BILLING_TAX_AUTHORITY',
    );
  });

  it("takes Hatti's support lines, each checked, the hours in both languages or neither (ADR-508)", () => {
    // Without them, shops send requests from the admin alone.
    expect(supportContactOf(loadApiConfig(env))).toBeNull();
    expect(
      supportContactOf(
        loadApiConfig({
          ...env,
          SUPPORT_WHATSAPP: '0300-1112233',
          SUPPORT_PHONE: '+92 42 3576 1999',
          SUPPORT_EMAIL: ' help@hatti.pk ',
          SUPPORT_HOURS: 'Monday to Saturday, 10am to 7pm',
          SUPPORT_HOURS_UR: 'پیر سے ہفتہ، صبح 10 سے شام 7',
        }),
      ),
    ).toEqual({
      whatsapp: '+923001112233',
      phone: '+924235761999',
      email: 'help@hatti.pk',
      hours: { en: 'Monday to Saturday, 10am to 7pm', ur: 'پیر سے ہفتہ، صبح 10 سے شام 7' },
    });
    expect(supportContactOf(loadApiConfig({ ...env, SUPPORT_EMAIL: 'help@hatti.pk' }))).toEqual({
      whatsapp: null,
      phone: null,
      email: 'help@hatti.pk',
      hours: null,
    });
    expect(() => loadApiConfig({ ...env, SUPPORT_WHATSAPP: '042-111-222-333' })).toThrow(
      'SUPPORT_WHATSAPP: Expected a Pakistani mobile number',
    );
    expect(() => loadApiConfig({ ...env, SUPPORT_PHONE: '111-222-333' })).toThrow(
      'SUPPORT_PHONE: Expected a Pakistani number',
    );
    expect(() => loadApiConfig({ ...env, SUPPORT_EMAIL: 'help' })).toThrow('SUPPORT_EMAIL');
    expect(() => loadApiConfig({ ...env, SUPPORT_HOURS: '10 to 7' })).toThrow(
      'SUPPORT_HOURS_UR: Set both SUPPORT_HOURS and SUPPORT_HOURS_UR, or neither',
    );
  });

  it("reads TikTok's Business API, which shops' advertiser accounts are checked on (ADR-566)", () => {
    expect(loadApiConfig(env).TIKTOK_API_URL).toBe('https://business-api.tiktok.com');
    expect(loadApiConfig({ ...env, TIKTOK_API_URL: 'http://localhost:4900' }).TIKTOK_API_URL).toBe(
      'http://localhost:4900',
    );
    expect(() => loadApiConfig({ ...env, TIKTOK_API_URL: 'business-api' })).toThrow(
      /TIKTOK_API_URL/,
    );
  });

  it("sizes the Admin API's buckets of query cost, apps' as Shopify's unless set (ADR-576)", () => {
    expect(queryCostLimitsOf(loadApiConfig(env))).toEqual({
      app: { maximum: 1_000, restoreRate: 50 },
      staff: { maximum: 2_000, restoreRate: 100 },
    });
    expect(
      queryCostLimitsOf(
        loadApiConfig({
          ...env,
          ADMIN_API_APP_BUCKET_SIZE: '2000',
          ADMIN_API_APP_RESTORE_RATE: '100',
          ADMIN_API_STAFF_BUCKET_SIZE: '4000',
          ADMIN_API_STAFF_RESTORE_RATE: '200',
        }),
      ),
    ).toEqual({
      app: { maximum: 2_000, restoreRate: 100 },
      staff: { maximum: 4_000, restoreRate: 200 },
    });
    expect(() => loadApiConfig({ ...env, ADMIN_API_APP_RESTORE_RATE: '0' })).toThrow(
      /ADMIN_API_APP_RESTORE_RATE/,
    );
    expect(() => loadApiConfig({ ...env, ADMIN_API_STAFF_BUCKET_SIZE: 'lots' })).toThrow(
      /ADMIN_API_STAFF_BUCKET_SIZE/,
    );
  });

  it("takes Hatti's support WhatsApp number with its token, or neither (ADR-560)", () => {
    // Without it, nothing written to WhatsApp is kept as a support request.
    expect(supportLineOf(loadApiConfig(env))).toBeNull();
    const line = {
      SUPPORT_WHATSAPP_PHONE_NUMBER_ID: '300000000000003',
      SUPPORT_WHATSAPP_ACCESS_TOKEN: 'EAAQsupportToken'.padEnd(80, 'z'),
    };
    expect(supportLineOf(loadApiConfig({ ...env, ...line }))).toEqual({
      phoneNumberId: '300000000000003',
    });
    expect(() =>
      loadApiConfig({ ...env, SUPPORT_WHATSAPP_PHONE_NUMBER_ID: '300000000000003' }),
    ).toThrow(
      'SUPPORT_WHATSAPP_ACCESS_TOKEN: Set both SUPPORT_WHATSAPP_PHONE_NUMBER_ID and SUPPORT_WHATSAPP_ACCESS_TOKEN, or neither',
    );
    expect(() =>
      loadApiConfig({ ...env, ...line, SUPPORT_WHATSAPP_PHONE_NUMBER_ID: '+92 300' }),
    ).toThrow('SUPPORT_WHATSAPP_PHONE_NUMBER_ID: Expected digits');
    // Customers' replies come to the shared number: it is no support line.
    expect(() =>
      loadApiConfig({
        ...env,
        ...line,
        WHATSAPP_PHONE_NUMBER_ID: '300000000000003',
        WHATSAPP_ACCESS_TOKEN: 'EAAQsharedToken'.padEnd(80, 'y'),
      }),
    ).toThrow('SUPPORT_WHATSAPP_PHONE_NUMBER_ID: Must not be the shared notifications number');
  });
});

describe("Hatti's people's support requests tool (ADR-508)", () => {
  const logins = {
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_SYSTEM_URL: 'postgres://hatti_system:secret@localhost:5432/hatti',
  };

  it('reads the app and system logins', () => {
    expect(loadSupportRequestsConfig(logins)).toEqual({
      ...logins,
      META_GRAPH_URL: 'https://graph.facebook.com',
      META_GRAPH_VERSION: 'v26.0',
    });
    expect(() => loadSupportRequestsConfig({ DATABASE_URL: env.DATABASE_URL })).toThrow(
      'DATABASE_SYSTEM_URL',
    );
  });

  it("answers on WhatsApp from Hatti's support number where it is set up, with its token (ADR-560)", () => {
    expect(supportSenderOf(loadSupportRequestsConfig(logins))).toBeNull();
    expect(
      supportSenderOf(
        loadSupportRequestsConfig({
          ...logins,
          SUPPORT_WHATSAPP_PHONE_NUMBER_ID: '300000000000003',
          SUPPORT_WHATSAPP_ACCESS_TOKEN: 'EAAQsupportToken'.padEnd(80, 'z'),
          META_GRAPH_VERSION: 'v25.0',
        }),
      ),
    ).toEqual({ send: expect.any(Function) });
    expect(() =>
      loadSupportRequestsConfig({
        ...logins,
        SUPPORT_WHATSAPP_ACCESS_TOKEN: 'EAAQsupportToken'.padEnd(80, 'z'),
      }),
    ).toThrow('SUPPORT_WHATSAPP_ACCESS_TOKEN: Set both');
  });
});

describe("Hatti's people's transfers tool (ADR-254)", () => {
  it('reads the app and system logins, and where the API answers', () => {
    expect(
      loadBillingTransfersConfig({
        DATABASE_URL: env.DATABASE_URL,
        DATABASE_SYSTEM_URL: 'postgres://hatti_system:secret@localhost:5432/hatti',
      }),
    ).toEqual({
      DATABASE_URL: env.DATABASE_URL,
      DATABASE_SYSTEM_URL: 'postgres://hatti_system:secret@localhost:5432/hatti',
    });
    expect(() => loadBillingTransfersConfig({ DATABASE_URL: env.DATABASE_URL })).toThrow(
      'DATABASE_SYSTEM_URL',
    );
  });
});

describe('Worker configuration', () => {
  const worker = {
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_SYSTEM_URL: 'postgres://hatti_system:secret@localhost:5432/hatti',
    REDIS_URL: env.REDIS_URL,
  };

  it("takes the addresses to check for Hatti's parts as part=address pairs (ADR-536)", () => {
    expect(loadWorkerConfig(worker).STATUS_PROBES).toEqual([]);
    expect(
      loadWorkerConfig({
        ...worker,
        STATUS_PROBES: ' storefronts=https://demo.hatti.pk/ , admin=https://admin.hatti.pk/health',
      }).STATUS_PROBES,
    ).toEqual([
      { component: 'storefronts', url: 'https://demo.hatti.pk/' },
      { component: 'admin', url: 'https://admin.hatti.pk/health' },
    ]);
    for (const wrong of ['fax=https://x.pk', 'admin=ftp://x.pk', 'https://x.pk']) {
      expect(() => loadWorkerConfig({ ...worker, STATUS_PROBES: wrong })).toThrow('STATUS_PROBES');
    }
  });

  it("takes Cloudflare's zone and token together, or neither, to purge storefront pages", () => {
    expect(loadWorkerConfig(worker).CLOUDFLARE_ZONE_ID).toBeUndefined();
    expect(() => loadWorkerConfig({ ...worker, CLOUDFLARE_ZONE_ID: 'zone-1' })).toThrow(
      'CLOUDFLARE_API_TOKEN: Set both CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN, or neither',
    );
    const token = 't'.repeat(40);
    const both = loadWorkerConfig({
      ...worker,
      CLOUDFLARE_ZONE_ID: 'zone-1',
      CLOUDFLARE_API_TOKEN: token,
    });
    expect([both.CLOUDFLARE_ZONE_ID, both.CLOUDFLARE_API_TOKEN]).toEqual(['zone-1', token]);
  });

  it("reads the API's storage settings, to remove erased receipts' files (ADR-113)", () => {
    expect(loadWorkerConfig(worker)).toMatchObject({
      STORAGE_DRIVER: 'local',
      STORAGE_DIRECTORY: '.storage',
    });
    expect(loadWorkerConfig({ ...worker, ...R2 })).toMatchObject({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'hatti-files',
    });
    expect(() => loadWorkerConfig({ ...worker, STORAGE_DRIVER: 's3' })).toThrow(
      'STORAGE_DRIVER: Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for s3',
    );
    expect(() => loadWorkerConfig({ ...worker, NODE_ENV: 'production' })).toThrow(
      "STORAGE_DRIVER: Must be s3 in production: a local directory is one machine's",
    );
  });

  it("reads where conversions go, the keys that open shops' tokens and their storefronts' address (ADR-143)", () => {
    expect(loadWorkerConfig(worker)).toMatchObject({
      META_GRAPH_URL: 'https://graph.facebook.com',
      META_GRAPH_VERSION: 'v26.0',
      CONVERSIONS_INTERVAL_MS: 15_000,
      // Shops' spend pulled from their Meta ad accounts (ADR-564) and TikTok advertiser
      // accounts, on TikTok's Business API (ADR-566), every three hours.
      AD_SPEND_SYNC_INTERVAL_MS: 10_800_000,
      TIKTOK_API_URL: 'https://business-api.tiktok.com',
      // Tier-1 shops' invoices go to FBR's IMS, or its sandbox (ADR-555).
      FBR_POS_URL: 'https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData',
      FBR_POS_SANDBOX_URL: 'https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData',
      // Sales-tax-registered shops' through its digital invoicing, or its sandbox (ADR-562).
      FBR_DI_URL: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata',
      FBR_DI_SANDBOX_URL: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb',
      FISCAL_INTERVAL_MS: 15_000,
    });
    // Without the keys, no conversions are sent.
    expect(loadWorkerConfig(worker).ENCRYPTION_KEYS).toBeUndefined();
    const keyed = loadWorkerConfig({ ...worker, ENCRYPTION_KEYS: `k1:${SecretBox.generateKey()}` });
    expect(keyed.ENCRYPTION_KEYS).toBeInstanceOf(SecretBox);
    expect(() => loadWorkerConfig({ ...worker, META_GRAPH_VERSION: '26' })).toThrow(
      'META_GRAPH_VERSION: Expected a Graph API version, like v26.0',
    );
    expect(
      loadWorkerConfig({ ...worker, AD_SPEND_SYNC_INTERVAL_MS: '3600000' })
        .AD_SPEND_SYNC_INTERVAL_MS,
    ).toBe(3_600_000);
    expect(() => loadWorkerConfig({ ...worker, AD_SPEND_SYNC_INTERVAL_MS: '1000' })).toThrow(
      'AD_SPEND_SYNC_INTERVAL_MS',
    );
    expect(() => loadWorkerConfig({ ...worker, ...R2, NODE_ENV: 'production' })).toThrow(
      "STOREFRONT_URL: Required in production: conversions name shops' storefronts there",
    );
    expect(
      loadWorkerConfig({
        ...worker,
        ...R2,
        NODE_ENV: 'production',
        STOREFRONT_URL: 'https://hatti.pk',
        PUBLIC_URL: 'https://admin.hatti.pk',
      }),
    ).toMatchObject({ STOREFRONT_URL: 'https://hatti.pk', PUBLIC_URL: 'https://admin.hatti.pk' });
  });

  it("reads Hatti's WhatsApp number and the SMS gateway, each whole or not at all (ADR-146)", () => {
    expect(loadWorkerConfig(worker)).toMatchObject({
      SMS_SENDER: 'Hatti',
      MESSAGES_INTERVAL_MS: 5_000,
    });
    // Messages link customers' order pages at the API's address (ADR-147).
    expect(loadWorkerConfig(worker).PUBLIC_URL).toBeUndefined();
    expect(() =>
      loadWorkerConfig({
        ...worker,
        ...R2,
        NODE_ENV: 'production',
        STOREFRONT_URL: 'https://hatti.pk',
      }),
    ).toThrow("PUBLIC_URL: Required in production: messages link customers' order pages there");
    expect(() => loadWorkerConfig({ ...worker, WHATSAPP_PHONE_NUMBER_ID: '1098765432' })).toThrow(
      'WHATSAPP_ACCESS_TOKEN: Set both WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN, or neither',
    );
    expect(() =>
      loadWorkerConfig({
        ...worker,
        WHATSAPP_PHONE_NUMBER_ID: '+92 300',
        WHATSAPP_ACCESS_TOKEN: 't'.repeat(40),
      }),
    ).toThrow('WHATSAPP_PHONE_NUMBER_ID: Expected digits');
    expect(() =>
      loadWorkerConfig({ ...worker, SMS_GATEWAY_URL: 'https://sms.example.pk/send' }),
    ).toThrow('SMS_GATEWAY_KEY: Set both SMS_GATEWAY_URL and SMS_GATEWAY_KEY, or neither');
    expect(
      loadWorkerConfig({
        ...worker,
        WHATSAPP_PHONE_NUMBER_ID: '1098765432',
        WHATSAPP_ACCESS_TOKEN: 't'.repeat(40),
        SMS_GATEWAY_URL: 'https://sms.example.pk/send',
        SMS_GATEWAY_KEY: 'g'.repeat(32),
        SMS_SENDER: 'ZariFashion',
      }),
    ).toMatchObject({ WHATSAPP_PHONE_NUMBER_ID: '1098765432', SMS_SENDER: 'ZariFashion' });
  });

  it("reads Amazon SES's settings as the API does, to send orders' emails (ADR-181)", () => {
    const ses = {
      SES_REGION: 'ap-southeast-1',
      SES_ACCESS_KEY_ID: 'AKIAHATTITEST0000001',
      SES_SECRET_ACCESS_KEY: 's'.repeat(40),
    };
    expect(loadWorkerConfig(worker)).toMatchObject({ EMAIL_FROM: 'Hatti <no-reply@hatti.pk>' });
    expect(loadWorkerConfig(worker).SES_REGION).toBeUndefined();
    expect(
      loadWorkerConfig({ ...worker, ...ses, EMAIL_FROM: 'Zari via Hatti <orders@hatti.pk>' }),
    ).toMatchObject({ ...ses, EMAIL_FROM: 'Zari via Hatti <orders@hatti.pk>' });
    expect(() => loadWorkerConfig({ ...worker, ...ses, SES_ACCESS_KEY_ID: undefined })).toThrow(
      'SES_SECRET_ACCESS_KEY: Set SES_REGION, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY together, or none',
    );
  });

  it("reads Hatti's VAPID keys as the API does, whole or not at all, to push to staff (ADR-506)", () => {
    expect(vapidKeysOf(loadWorkerConfig(worker))).toBeNull();
    const vapid = {
      VAPID_PUBLIC_KEY: `B${'x'.repeat(86)}`,
      VAPID_PRIVATE_KEY: 'p'.repeat(43),
      VAPID_SUBJECT: 'mailto:push@hatti.pk',
    };
    expect(vapidKeysOf(loadWorkerConfig({ ...worker, ...vapid }))).toEqual({
      publicKey: vapid.VAPID_PUBLIC_KEY,
      privateKey: vapid.VAPID_PRIVATE_KEY,
      subject: 'mailto:push@hatti.pk',
    });
    expect(vapidKeysOf(loadApiConfig({ ...env, ...vapid }))?.subject).toBe('mailto:push@hatti.pk');
    const partial = { ...vapid, VAPID_SUBJECT: undefined };
    const message =
      'VAPID_SUBJECT: Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together, or none';
    expect(() => loadWorkerConfig({ ...worker, ...partial })).toThrow(message);
    expect(() => loadApiConfig({ ...env, ...partial })).toThrow(message);
    expect(() => loadWorkerConfig({ ...worker, ...vapid, VAPID_SUBJECT: 'push@hatti.pk' })).toThrow(
      'VAPID_SUBJECT',
    );
    expect(() => loadWorkerConfig({ ...worker, ...vapid, VAPID_PUBLIC_KEY: 'short' })).toThrow(
      'VAPID_PUBLIC_KEY',
    );
  });
});
