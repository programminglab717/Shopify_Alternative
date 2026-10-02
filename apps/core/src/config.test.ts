import { SecretBox } from '@hatti/crypto';
import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig, passkeysOf } from './config.js';

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
      }).STOREFRONT_URL,
    ).toBe('https://hatti.pk');
  });

  it("reads Hatti's WhatsApp number and the SMS gateway, each whole or not at all (ADR-146)", () => {
    expect(loadWorkerConfig(worker)).toMatchObject({
      SMS_SENDER: 'Hatti',
      MESSAGES_INTERVAL_MS: 5_000,
    });
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
});
