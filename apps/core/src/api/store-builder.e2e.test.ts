import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { kitOf, planStore } from './store-builder.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const DESCRIPTION =
  'Zari sells unstitched lawn suits and printed kurtas from Faisalabad, made for summer.\n\n' +
  'We ship across Pakistan with cash on delivery & easy exchanges.';

const BUILD = `mutation ($input: StoreBuildInput!) {
  storeBuild(input: $input) {
    plan { kit accentColour aboutHtml seoTitle seoDescription }
    collectionsMade sizeChartsMade menuLinksAdded accentSet seoSet
    aboutPage { handle }
    userErrors { field code }
  }
}`;

describe('The store builder reads what a shop sells (ONB-03, ADR-502)', () => {
  it('picks the kit its words call for most, and writes its page and SEO from them', () => {
    expect(kitOf(DESCRIPTION)).toBe('fashion');
    expect(kitOf('Handmade kundan jhumkas and bangles, silver rings too')).toBe('jewellery');
    expect(kitOf('Pure honey, desi ghee and achar from our village')).toBe('grocery');
    expect(kitOf('We do many things')).toBeNull();
    const plan = planStore('Zari', DESCRIPTION);
    expect(plan).toEqual({
      kit: 'fashion',
      accent: '#9F1239',
      about:
        '<p>Zari sells unstitched lawn suits and printed kurtas from Faisalabad, made for summer.</p>\n' +
        '<p>We ship across Pakistan with cash on delivery &amp; easy exchanges.</p>',
      seo: {
        title: 'Zari',
        description:
          'Zari sells unstitched lawn suits and printed kurtas from Faisalabad, made for summer.',
      },
    });
    expect(planStore('Zari', 'x '.repeat(200)).seo.description.length).toBeLessThanOrEqual(160);
  });
});

describe.skipIf(!server)('Admin GraphQL API: the store builder (ONB-03, ADR-502)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', products: '' };

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const issue = async (scopes: string[]) => {
      const { token, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
         VALUES ($1, 'test', $2, $3, $4)`,
        [shop, hash, hint, scopes],
      );
      return token;
    };
    tokens.owner = await issue([
      'write_products',
      'write_online_store_navigation',
      'write_online_store_pages',
      'write_themes',
      'write_settings',
    ]);
    tokens.products = await issue(['write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('sets the shop up from its description, keeping what it set, and refuses what is wrong', async () => {
    const plan = await data(
      tokens.products,
      '{ storeBuildPlan(description: "Lawn suits and kurtas for summer") { kit accentColour } }',
    );
    expect(plan).toEqual({ kit: 'FASHION', accentColour: '#9F1239' });
    const denied = await gql(tokens.products, BUILD, { input: { description: DESCRIPTION } });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(
      await data(tokens.owner, BUILD, { input: { description: 'Too short', accentColour: 'red' } }),
    ).toMatchObject({
      plan: null,
      userErrors: [
        { field: ['input', 'description'], code: 'INVALID' },
        { field: ['input', 'accentColour'], code: 'INVALID' },
      ],
    });

    const theme = await data(
      tokens.owner,
      'mutation { themeCreate(name: "Hatti Base") { theme { id } userErrors { code } } }',
    );
    await data(
      tokens.owner,
      `mutation { themePublish(id: "${theme.theme.id}") { userErrors { code } } }`,
    );

    const built = await data(tokens.owner, BUILD, { input: { description: DESCRIPTION } });
    expect(built).toMatchObject({
      plan: { kit: 'FASHION', accentColour: '#9F1239', seoTitle: 'Zari' },
      collectionsMade: 7,
      sizeChartsMade: 2,
      menuLinksAdded: 7,
      accentSet: true,
      seoSet: true,
      aboutPage: { handle: 'about-us' },
      userErrors: [],
    });
    const files = await data(
      tokens.owner,
      `{ theme(id: "${theme.theme.id}") { files(filenames: ["config/settings_data.json"]) { body } } }`,
    );
    expect(JSON.parse(files.files[0].body).current.color_accent).toBe('#9F1239');
    const preferences = await data(
      tokens.owner,
      '{ onlineStorePreferences { seo { title description } } }',
    );
    expect(preferences.seo).toEqual({
      title: 'Zari',
      description:
        'Zari sells unstitched lawn suits and printed kurtas from Faisalabad, made for summer.',
    });

    // Again, with a colour of its own: the page and the SEO it has are left as they are.
    const again = await data(tokens.owner, BUILD, {
      input: { description: DESCRIPTION, accentColour: '#0F766E' },
    });
    expect(again).toMatchObject({
      plan: { accentColour: '#0F766E' },
      collectionsMade: 0,
      accentSet: true,
      seoSet: false,
      aboutPage: null,
    });
  });
});
