import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';

const KEY = 'k'.repeat(32);

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
});
