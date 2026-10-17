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
    // One of the Free plan's ten AI credits this month spent (ADR-533).
    expect(
      (await gql(tokens.reader, '{ translationDrafting { creditsLeft creditsPerMonth } }')).data,
    ).toEqual({ translationDrafting: { creditsLeft: 9, creditsPerMonth: 10 } });
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

  it("drafts a product's copy in Roman Urdu from what the shop says (CAT-20, ADR-471)", async () => {
    expect(
      (await gql(tokens.writer, '{ productCopyDrafting { available usedToday limitPerDay } }'))
        .data,
    ).toEqual({ productCopyDrafting: { available: true, usedToday: 0, limitPerDay: 100 } });
    answers.push({
      content: [
        {
          type: 'tool_use',
          name: 'give_product_copy',
          input: {
            title: 'Printed lawn ka 3-piece suit',
            description_html: '<p>Garmiyon ke liye lawn.</p><ul><li>Shirt: 3m</li></ul>',
            seo_title: 'Printed lawn 3-piece suit | Zari',
            seo_description: 'Zari ka printed lawn suit, chiffon dupatta ke saath.',
          },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 380, output_tokens: 160 },
    });
    const draft = `mutation ($input: ProductCopyDraftInput!) {
      productCopyDraft(input: $input) {
        draft { title descriptionHtml seoTitle seoDescription } userErrors { field code }
      }
    }`;
    const drafted = await gql(tokens.writer, draft, {
      input: {
        language: 'ROMAN_URDU',
        title: 'Lawn suit',
        options: [{ name: 'Colour', values: ['Mint'] }],
        notes: 'Shirt 3m, chiffon dupatta',
      },
    });
    expect(drafted.data!.productCopyDraft).toEqual({
      draft: {
        title: 'Printed lawn ka 3-piece suit',
        descriptionHtml: '<p>Garmiyon ke liye lawn.</p><ul><li>Shirt: 3m</li></ul>',
        seoTitle: 'Printed lawn 3-piece suit | Zari',
        seoDescription: 'Zari ka printed lawn suit, chiffon dupatta ke saath.',
      },
      userErrors: [],
    });
    // A product that is not the shop's is refused before the AI is asked.
    const stranger = await gql(tokens.writer, draft, {
      input: { language: 'ENGLISH', title: 'Kurta', productId: 'gid://shopify/Product/nope' },
    });
    expect(stranger.data!.productCopyDraft.userErrors).toEqual([
      { field: ['input', 'productId'], code: 'NOT_FOUND' },
    ]);
    // Asking needs write_products.
    expect(
      (await gql(tokens.reader, draft, { input: { language: 'ENGLISH', title: 'Kurta' } }))
        .errors?.[0]?.extensions?.code,
    ).toBe('ACCESS_DENIED');
  });
});
