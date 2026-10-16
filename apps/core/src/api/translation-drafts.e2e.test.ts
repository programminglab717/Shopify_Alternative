import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { AiGateway } from '@hatti/ai';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)('Admin GraphQL API: AI drafts of translations (CAT-07)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shopId = newId();
  const tokens = { writer: '', reader: '' };
  const answers: unknown[] = [];

  async function issueToken(scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json>; errors?: Json[] };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopId]);
    const fetch = (async () =>
      new Response(JSON.stringify(answers.shift()), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    api = await startTestApi(testDb, {
      ai: new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch }),
    });
    tokens.writer = await issueToken(['write_translations', 'write_products']);
    tokens.reader = await issueToken(['read_translations']);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("drafts a product's title in Urdu, for the shop to keep with its digest", async () => {
    const created = await gql(
      tokens.writer,
      `mutation { productCreate(input: { title: "Lawn Suit" }) { product { id } } }`,
    );
    const productId = created.data!.productCreate.product.id as string;
    expect(
      (await gql(tokens.reader, '{ translationDrafting { available usedToday limitPerDay } }'))
        .data,
    ).toEqual({ translationDrafting: { available: true, usedToday: 0, limitPerDay: 100 } });

    answers.push({
      content: [
        {
          type: 'tool_use',
          name: 'give_translations',
          input: { translations: [{ key: 'title', value: 'لان سوٹ' }] },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 500, output_tokens: 40 },
    });
    const draft = `mutation ($id: ID!) {
      translationsDraft(resourceId: $id, locale: "ur", keys: ["title"]) {
        drafts { key value translatableContentDigest } userErrors { field code }
      }
    }`;
    const drafted = await gql(tokens.writer, draft, { id: productId });
    expect(drafted.data!.translationsDraft).toEqual({
      drafts: [{ key: 'title', value: 'لان سوٹ', translatableContentDigest: expect.any(String) }],
      userErrors: [],
    });
    // Kept only through translationsRegister; asking needs write_translations.
    const kept = await gql(
      tokens.writer,
      `mutation ($id: ID!, $t: [TranslationInput!]!) {
        translationsRegister(resourceId: $id, translations: $t) { userErrors { code } }
      }`,
      {
        id: productId,
        t: [
          {
            locale: 'ur',
            key: 'title',
            value: 'لان سوٹ',
            translatableContentDigest:
              drafted.data!.translationsDraft.drafts[0].translatableContentDigest,
          },
        ],
      },
    );
    expect(kept.data!.translationsRegister.userErrors).toEqual([]);
    const denied = await gql(tokens.reader, draft, { id: productId });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});
