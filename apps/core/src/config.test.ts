import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig } from './config.js';

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
});
