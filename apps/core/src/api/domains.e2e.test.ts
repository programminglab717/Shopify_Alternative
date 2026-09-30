import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TestDns, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const DOMAIN_FIELDS = 'id host url isVerified verifiedAt isPrimary dnsTarget';
const PAYLOAD = `domain { ${DOMAIN_FIELDS} } userErrors { field code message }`;

describe.skipIf(!server)("Admin GraphQL API: shops' own domains", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const dns = new TestDns();
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', b: '', products: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json>; errors?: Json[] };
  }

  async function call(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const connect = (token: string, host: string) =>
    call(
      token,
      `mutation ($domain: DomainCreateInput!) { domainCreate(domain: $domain) { ${PAYLOAD} } }`,
      { domain: { host } },
    );
  const verify = (token: string, id: string) =>
    call(token, `mutation ($id: ID!) { domainVerify(id: $id) { ${PAYLOAD} } }`, { id });
  const primary = (token: string, id: string, isPrimary: boolean) =>
    call(
      token,
      `mutation ($id: ID!, $domain: DomainUpdateInput!) {
        domainUpdate(id: $id, domain: $domain) { ${PAYLOAD} }
      }`,
      { id, domain: { isPrimary } },
    );
  const shopUrl = async (token: string) => (await call(token, '{ shop { url } }')).url as string;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'Other', 'other')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_domains']);
    tokens.reader = await issueToken(shopA, ['read_domains']);
    tokens.b = await issueToken(shopB, ['write_domains']);
    tokens.products = await issueToken(shopA, ['write_products']);
    api = await startTestApi(testDb, { dns });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("connects a domain, checks its DNS, and makes it the storefront's address", async () => {
    const created = await connect(tokens.a, 'https://www.Zari.pk/');
    expect(created).toEqual({
      domain: {
        id: expect.stringMatching(/^dom_[0-9A-Za-z]+$/),
        host: 'www.zari.pk',
        url: 'http://www.zari.pk:4100',
        isVerified: false,
        verifiedAt: null,
        isPrimary: false,
        dnsTarget: 'shops.localhost',
      },
      userErrors: [],
    });
    const id = created.domain.id as string;
    expect((await connect(tokens.b, 'www.zari.pk')).userErrors).toEqual([
      {
        field: ['domain', 'host'],
        code: 'TAKEN',
        message: 'www.zari.pk is connected to a shop already',
      },
    ]);

    // Not pointed yet: said so, and it cannot be primary.
    expect((await verify(tokens.a, id)).userErrors[0].code).toBe('NOT_POINTED');
    expect((await primary(tokens.a, id, true)).userErrors[0]).toMatchObject({
      field: ['domain', 'isPrimary'],
      code: 'NOT_POINTED',
    });
    dns.records.set('www.zari.pk', { cnames: ['shops.localhost'] });
    expect((await verify(tokens.a, id)).domain).toMatchObject({ isVerified: true });
    expect(await shopUrl(tokens.a)).toBe('http://zari.localhost:4100');
    expect((await primary(tokens.a, id, true)).domain.isPrimary).toBe(true);
    expect(await shopUrl(tokens.a)).toBe('http://www.zari.pk:4100');

    expect(await call(tokens.reader, '{ domains { host isPrimary } }')).toEqual([
      { host: 'www.zari.pk', isPrimary: true },
    ]);
    expect(await call(tokens.b, '{ domains { host } }')).toEqual([]);
    const deleted = await call(
      tokens.a,
      'mutation ($id: ID!) { domainDelete(id: $id) { deletedDomainId userErrors { code } } }',
      { id },
    );
    expect(deleted).toEqual({ deletedDomainId: id, userErrors: [] });
    expect(await shopUrl(tokens.a)).toBe('http://zari.localhost:4100');
  });

  it('needs read_domains to see domains and write_domains to change them', async () => {
    const denied = async (token: string, query: string) =>
      (await gql(token, query)).errors?.[0]?.extensions?.code;
    expect(await denied(tokens.products, '{ domains { host } }')).toBe('ACCESS_DENIED');
    expect(
      await denied(
        tokens.reader,
        'mutation { domainCreate(domain: { host: "zari.pk" }) { userErrors { code } } }',
      ),
    ).toBe('ACCESS_DENIED');
  });
});
