import { SecretBox } from '@hatti/crypto';
import { describe, expect, it } from 'vitest';
import { hattiBankAccountOf, hattiGatewayOf } from './billing.js';
import {
  loadApiConfig,
  loadBillingTransfersConfig,
  loadWorkerConfig,
  passkeysOf,
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
    });
    // Without the keys, no conversions are sent.
    expect(loadWorkerConfig(worker).ENCRYPTION_KEYS).toBeUndefined();
    const keyed = loadWorkerConfig({ ...worker, ENCRYPTION_KEYS: `k1:${SecretBox.generateKey()}` });
    expect(keyed.ENCRYPTION_KEYS).toBeInstanceOf(SecretBox);
    expect(() => loadWorkerConfig({ ...worker, META_GRAPH_VERSION: '26' })).toThrow(
      'META_GRAPH_VERSION: Expected a Graph API version, like v26.0',
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
});
