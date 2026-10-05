import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; path?: string[]; extensions?: { code?: string } }[];
}

const ITEM_FIELDS = 'id title type resourceId url tags';
const MENU_FIELDS = `id handle title isDefault items { ${ITEM_FIELDS} items { ${ITEM_FIELDS} } }`;

describe.skipIf(!server)('Admin GraphQL API: online store menus', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', products: '', b: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json() as GraphQLResponse;
  }

  /** Runs a query or mutation and returns its first field, failing the test on GraphQL errors. */
  async function call(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const collection = async (token: string, title: string) =>
    (
      await call(
        token,
        `mutation ($title: String!) {
          collectionCreate(input: { title: $title }) { collection { id handle } }
        }`,
        { title },
      )
    ).collection;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_online_store_navigation', 'write_products']);
    tokens.reader = await issueToken(shopA, ['read_online_store_navigation']);
    tokens.products = await issueToken(shopA, ['write_products']);
    tokens.b = await issueToken(shopB, ['write_online_store_navigation', 'write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('lists the main and footer menus, and makes and changes menus of nested links', async () => {
    const eid = await collection(tokens.a, 'Eid Edit');
    const list = await call(tokens.reader, `{ menus(first: 5) { nodes { ${MENU_FIELDS} } } }`);
    expect(list.nodes.map((menu: Json) => [menu.handle, menu.title, menu.isDefault])).toEqual([
      ['main-menu', 'Main menu', true],
      ['footer', 'Footer menu', true],
    ]);
    expect(list.nodes[0].id).toMatch(/^mnu_[0-9a-z]{26}$/);
    // The collection has no products, so the storefront led to all products alone.
    expect(list.nodes[0].items).toEqual([
      {
        id: expect.stringMatching(/^mni_[0-9a-z]{26}$/),
        title: 'All products',
        type: 'CATALOG',
        resourceId: null,
        url: '/collections/all',
        tags: [],
        items: [],
      },
    ]);

    const created = await call(
      tokens.a,
      `mutation ($items: [MenuItemCreateInput!]!) {
        menuCreate(title: "Shop by", handle: "shop-by", items: $items) {
          menu { ${MENU_FIELDS} } userErrors { field code message }
        }
      }`,
      {
        items: [
          { title: 'Home', type: 'FRONTPAGE' },
          {
            title: 'Eid',
            type: 'COLLECTION',
            resourceId: eid.id,
            items: [{ title: 'Ask us', type: 'HTTP', url: 'https://wa.me/923001234567' }],
          },
        ],
      },
    );
    expect(created.userErrors).toEqual([]);
    expect(created.menu).toMatchObject({
      handle: 'shop-by',
      isDefault: false,
      items: [
        { title: 'Home', type: 'FRONTPAGE', url: '/', resourceId: null },
        {
          title: 'Eid',
          type: 'COLLECTION',
          url: '/collections/eid-edit',
          resourceId: eid.id,
          items: [{ title: 'Ask us', type: 'HTTP', url: 'https://wa.me/923001234567' }],
        },
      ],
    });

    // A kind of link menus take later, and an address that could end an attribute.
    const refused = await call(
      tokens.a,
      `mutation {
        menuCreate(title: "Help", handle: "help", items: [
          { title: "Search", type: SEARCH }, { title: "Sale", type: HTTP, url: "javascript:x()" }
        ]) { menu { id } userErrors { field code } }
      }`,
    );
    expect(refused).toEqual({
      menu: null,
      userErrors: [
        { field: ['items', '0', 'type'], code: 'INVALID' },
        { field: ['items', '1', 'url'], code: 'INVALID' },
      ],
    });

    // Changed whole: an item given again keeps its ID; the others go.
    const home = created.menu.items[0];
    const updated = await call(
      tokens.a,
      `mutation ($id: ID!, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: "Shop", handle: "shop", items: $items) {
          menu { handle title items { id title } } userErrors { field code }
        }
      }`,
      { id: created.menu.id, items: [{ id: home.id, title: 'Home', type: 'FRONTPAGE' }] },
    );
    expect(updated).toEqual({
      menu: { handle: 'shop', title: 'Shop', items: [{ id: home.id, title: 'Home' }] },
      userErrors: [],
    });

    const DELETE = `mutation ($id: ID!) {
      menuDelete(id: $id) { deletedMenuId userErrors { field code } }
    }`;
    expect(await call(tokens.a, DELETE, { id: created.menu.id })).toEqual({
      deletedMenuId: created.menu.id,
      userErrors: [],
    });
    expect(await call(tokens.a, DELETE, { id: list.nodes[1].id })).toEqual({
      deletedMenuId: null,
      userErrors: [{ field: ['id'], code: 'INVALID' }],
    });
  });

  it('needs the navigation scopes, and keeps each shop to its own menus', async () => {
    for (const [token, query] of [
      [tokens.products, '{ menus(first: 1) { nodes { id } } }'],
      [
        tokens.reader,
        'mutation { menuCreate(title: "x", handle: "x", items: []) { menu { id } } }',
      ],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
    const theirs = (await call(tokens.b, '{ menus(first: 1) { nodes { id } } }')).nodes[0].id;
    expect(await call(tokens.reader, `{ menu(id: "${theirs}") { id } }`)).toBeNull();
    const update = await call(
      tokens.a,
      `mutation ($id: ID!) {
        menuUpdate(id: $id, title: "Mine", items: []) { menu { id } userErrors { field code } }
      }`,
      { id: theirs },
    );
    expect(update).toEqual({ menu: null, userErrors: [{ field: ['id'], code: 'NOT_FOUND' }] });
    // Nor may a menu link to another shop's collection.
    const other = await collection(tokens.b, 'Theirs');
    const linked = await call(
      tokens.a,
      `mutation ($id: ID!) {
        menuCreate(title: "x", handle: "x", items: [{ title: "x", type: COLLECTION, resourceId: $id }]) {
          menu { id } userErrors { field code }
        }
      }`,
      { id: other.id },
    );
    expect(linked).toEqual({
      menu: null,
      userErrors: [{ field: ['items', '0', 'resourceId'], code: 'NOT_FOUND' }],
    });
  });
});
