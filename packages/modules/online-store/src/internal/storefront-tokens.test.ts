import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  STOREFRONT_TOKEN_LIMITS,
  StorefrontTokenService,
  storefrontTokenDigest,
  storefrontTokensIn,
} from './storefront-tokens.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

/** The field and code of each error. */
const codesOf = (result: Parameters<typeof errorsOf>[0]) =>
  errorsOf(result).map(([field, code]) => [field, code]);

const server = testDatabaseServer();

describe.skipIf(!server)('Storefront API tokens (DEV-02, ADR-848)', () => {
  let f: OnlineStoreFixture;
  let tokens: StorefrontTokenService;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    tokens = new StorefrontTokenService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('makes public and private tokens, each given once and kept as its digest', async () => {
    const made = unwrap(await tokens.create(f.a, { title: ' Our app ', kind: 'public' }));
    expect(made.accessToken).toMatch(/^hsf_[\w-]{32}$/);
    expect(made.record).toMatchObject({
      title: 'Our app',
      kind: 'public',
      hint: made.accessToken.slice(-4),
    });
    const server = unwrap(await tokens.create(f.a, { title: 'Our server', kind: 'private' }));
    expect(server.accessToken).toMatch(/^hsfp_/);
    expect((await tokens.list(f.a)).map((token) => token.title)).toEqual(['Our app', 'Our server']);
    // Kept as digests, which the storefront's document carries; never the token itself.
    const { rows } = await f.admin.query<{ digest: Buffer }>(
      'SELECT token_digest AS digest FROM online_store.storefront_access_tokens WHERE shop_id = $1',
      [f.a.shopId],
    );
    expect(rows.map((row) => row.digest.toString('hex')).sort()).toEqual(
      [storefrontTokenDigest(made.accessToken), storefrontTokenDigest(server.accessToken)].sort(),
    );
    expect(await f.db.tenant(f.a.shopId, (tx) => storefrontTokensIn(tx, f.a.shopId))).toEqual([
      { digest: storefrontTokenDigest(made.accessToken), private: false },
      { digest: storefrontTokenDigest(server.accessToken), private: true },
    ]);
    // Each change tells the storefront's publisher.
    expect(
      (await f.outbox()).filter((event) => event.event_type === 'storefront_access_tokens.updated'),
    ).toHaveLength(2);
    // Another shop sees none of them.
    expect(await tokens.list(f.b)).toEqual([]);
  });

  it('deletes a token, and refuses a title too long, a token of another shop, and too many', async () => {
    const made = unwrap(await tokens.create(f.a, { title: 'App', kind: 'public' }));
    expect(codesOf(await tokens.delete(f.b, made.record.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(unwrap(await tokens.delete(f.a, made.record.id))).toBe(made.record.id);
    expect(await tokens.list(f.a)).toEqual([]);
    expect(
      codesOf(
        await tokens.create(f.a, {
          title: 'x'.repeat(STOREFRONT_TOKEN_LIMITS.title + 1),
          kind: 'public',
        }),
      ),
    ).toEqual([['input.title', 'INVALID']]);
    await f.admin.query(
      `INSERT INTO online_store.storefront_access_tokens (shop_id, title, kind, token_digest, token_hint)
       SELECT $1, 'App ' || n, 'public', sha256(n::text::bytea), 'abcd'
         FROM generate_series(1, $2) AS n`,
      [f.a.shopId, STOREFRONT_TOKEN_LIMITS.perShop],
    );
    expect(codesOf(await tokens.create(f.a, { title: 'One more', kind: 'public' }))).toEqual([
      ['base', 'TOO_MANY'],
    ]);
  });
});
