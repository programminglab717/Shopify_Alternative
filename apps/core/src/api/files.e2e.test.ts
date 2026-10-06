import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STAGE = `mutation ($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url httpMethod parameters { name value } resourceUrl }
    userErrors { field code message }
  }
}`;

const CREATE = `mutation ($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id filename mimeType fileSize alt url }
    userErrors { field code message }
  }
}`;

/** A PNG's signature, then `size` bytes in all. */
const png = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8, 7),
  ]);

describe.skipIf(!server)('Admin GraphQL API: files', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', reader: '', clerk: '' };

  async function issueToken(scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  /** What a client does with a signed URL, here against the API's local storage. */
  const call = (method: 'PUT' | 'GET', url: string, body?: Buffer, type = 'image/png') =>
    app.inject({
      method,
      url: url.replace('http://localhost:4000', ''),
      ...(body && { payload: body, headers: { 'content-type': type } }),
    });

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.owner = await issueToken(['write_files']);
    tokens.reader = await issueToken(['read_files']);
    tokens.clerk = await issueToken(['write_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('stages an upload, takes it straight to storage, and shows the file it makes', async () => {
    const staged = await gql(tokens.owner, STAGE, {
      input: [{ filename: 'Lawn collection.png', mimeType: 'image/png', fileSize: '64' }],
    });
    const [target] = staged.data!.stagedUploadsCreate.stagedTargets;
    expect(target).toMatchObject({
      httpMethod: 'PUT',
      parameters: [{ name: 'content-type', value: 'image/png' }],
    });
    expect(target.resourceUrl).toMatch(
      new RegExp(
        `^http://localhost:4000/storage/shops/${shop}/files/[0-9a-f-]{36}/Lawn-collection\\.png$`,
      ),
    );
    // Only the bytes and the type it was signed for, only by PUT.
    expect((await call('PUT', target.url, png(65))).statusCode).toBe(403);
    expect((await call('PUT', target.url, png(64), 'text/html')).statusCode).toBe(403);
    expect(
      (await call('PUT', target.url.replace('length=64', 'length=65'), png(65))).statusCode,
    ).toBe(403);
    expect((await call('GET', target.url)).statusCode).toBe(403);
    expect((await call('PUT', target.url, png(64))).statusCode).toBe(200);

    const created = await gql(tokens.owner, CREATE, {
      files: [{ originalSource: target.resourceUrl, alt: 'Three lawn suits' }],
    });
    const [file] = created.data!.fileCreate.files;
    expect(file).toMatchObject({
      id: expect.stringMatching(/^file_/),
      filename: 'Lawn collection.png',
      mimeType: 'image/png',
      fileSize: 64,
      alt: 'Three lawn suits',
    });
    const shown = await call('GET', file.url);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': `inline; filename="Lawn collection.png"; filename*=UTF-8''Lawn%20collection.png`,
      'x-content-type-options': 'nosniff',
    });
    expect(shown.rawPayload.equals(png(64))).toBe(true);

    const listed = await gql(tokens.reader, '{ files(first: 5) { nodes { id fileSize } } }');
    expect(listed.data?.files.nodes).toEqual([{ id: file.id, fileSize: 64 }]);
    for (const [token, query] of [
      [tokens.clerk, '{ files(first: 5) { nodes { id } } }'],
      [tokens.reader, `mutation { fileDelete(fileIds: ["${file.id}"]) { deletedFileIds } }`],
    ] as const) {
      expect((await gql(token, query)).errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }

    const deleted = await gql(
      tokens.owner,
      `mutation ($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { code } } }`,
      { ids: [file.id] },
    );
    expect(deleted.data?.fileDelete).toEqual({ deletedFileIds: [file.id], userErrors: [] });
    expect((await call('GET', file.url)).statusCode).toBe(404);
  });

  it("sets the shop's logo from its files, an image", async () => {
    /** A file made of `bytes`, uploaded as a client does: its ID. */
    const upload = async (filename: string, mimeType: string, bytes: Buffer) => {
      const staged = await gql(tokens.owner, STAGE, {
        input: [{ filename, mimeType, fileSize: String(bytes.length) }],
      });
      const [target] = staged.data!.stagedUploadsCreate.stagedTargets;
      expect((await call('PUT', target.url, bytes, mimeType)).statusCode).toBe(200);
      const created = await gql(tokens.owner, CREATE, {
        files: [{ originalSource: target.resourceUrl }],
      });
      return created.data!.fileCreate.files[0].id as string;
    };
    const logo = await upload('Zari logo.png', 'image/png', png(64));
    const catalogue = await upload('Catalogue.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n'));
    const UPDATE = `mutation ($input: ShopBrandInput!) {
      shopBrandUpdate(input: $input) {
        brand { logo { id filename } }
        userErrors { field code message }
      }
    }`;
    const BRAND = '{ shop { brand { logo { id mimeType url } squareLogo { id } updatedAt } } }';
    expect((await gql(tokens.reader, BRAND)).data?.shop.brand).toEqual({
      logo: null,
      squareLogo: null,
      updatedAt: null,
    });
    expect((await gql(tokens.owner, UPDATE, { input: { logo: catalogue } })).data).toEqual({
      shopBrandUpdate: {
        brand: null,
        userErrors: [
          {
            field: ['input', 'logo'],
            code: 'INVALID',
            message: 'A logo is an image: JPEG, PNG, WebP or GIF, not application/pdf',
          },
        ],
      },
    });
    expect((await gql(tokens.owner, UPDATE, { input: { logo } })).data).toEqual({
      shopBrandUpdate: {
        brand: { logo: { id: logo, filename: 'Zari logo.png' } },
        userErrors: [],
      },
    });
    const brand = (await gql(tokens.reader, BRAND)).data?.shop.brand;
    expect(brand).toMatchObject({ logo: { id: logo, mimeType: 'image/png' } });
    expect((await call('GET', brand.logo.url)).rawPayload.equals(png(64))).toBe(true);
    // Files' scopes: to see it, and to change it.
    for (const [token, query, variables] of [
      [tokens.clerk, BRAND, undefined],
      [tokens.reader, UPDATE, { input: { logo: null } }],
    ] as const) {
      expect((await gql(token, query, variables)).errors?.[0]?.extensions?.code, query).toBe(
        'ACCESS_DENIED',
      );
    }
    // At the API's own address too, for the emails of its orders' news (ADR-198).
    const served = await call('GET', `/logos/${shop}`);
    expect([served.statusCode, served.headers['content-type']]).toEqual([200, 'image/png']);
    expect(served.headers['cache-control']).toBe('public, max-age=3600');
    expect(served.rawPayload.equals(png(64))).toBe(true);
    // Its square logo beside it, for its link page, at an address of its own (ADR-205).
    const square = await upload('Zari square.png', 'image/png', png(48));
    const squared = await gql(
      tokens.owner,
      `mutation ($input: ShopBrandInput!) {
        shopBrandUpdate(input: $input) { brand { logo { id } squareLogo { id filename } } }
      }`,
      { input: { squareLogo: square } },
    );
    expect(squared.data?.shopBrandUpdate.brand).toEqual({
      logo: { id: logo },
      squareLogo: { id: square, filename: 'Zari square.png' },
    });
    const servedSquare = await call('GET', `/logos/${shop}/square`);
    expect([servedSquare.statusCode, servedSquare.headers['content-type']]).toEqual([
      200,
      'image/png',
    ]);
    expect(servedSquare.rawPayload.equals(png(48))).toBe(true);
    const removed = await gql(tokens.owner, UPDATE, { input: { logo: null, squareLogo: null } });
    expect(removed.data?.shopBrandUpdate).toEqual({ brand: { logo: null }, userErrors: [] });
    // None now, nor for another shop, nor for what is no shop.
    for (const path of [
      `/logos/${shop}`,
      `/logos/${shop}/square`,
      `/logos/${newId()}`,
      `/logos/${newId()}/square`,
      '/logos/zari',
    ]) {
      expect((await call('GET', path)).statusCode, path).toBe(404);
    }
  });

  it("shows an article's image, one of the shop's files, at an address of its own while the article is published (ADR-213)", async () => {
    const writer = await issueToken(['write_files', 'write_content']);
    const upload = async (filename: string, mimeType: string, bytes: Buffer) => {
      const staged = await gql(writer, STAGE, {
        input: [{ filename, mimeType, fileSize: String(bytes.length) }],
      });
      const [target] = staged.data!.stagedUploadsCreate.stagedTargets;
      expect((await call('PUT', target.url, bytes, mimeType)).statusCode).toBe(200);
      const created = await gql(writer, CREATE, {
        files: [{ originalSource: target.resourceUrl }],
      });
      return created.data!.fileCreate.files[0].id as string;
    };
    const photo = await upload('Eid lawn.png', 'image/png', png(96));
    const catalogue = await upload('Lookbook.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n'));
    const blog = (
      await gql(
        writer,
        `mutation { blogCreate(blog: { title: "News" }) { blog { id } userErrors { message } } }`,
      )
    ).data!.blogCreate.blog.id as string;
    const CREATE_ARTICLE = `mutation ($article: ArticleCreateInput!) {
      articleCreate(article: $article) {
        article { id image { fileId altText } }
        userErrors { field code message }
      }
    }`;
    const refused = await gql(writer, CREATE_ARTICLE, {
      article: { blogId: blog, title: 'Lookbook', image: { fileId: catalogue } },
    });
    expect(refused.data!.articleCreate).toEqual({
      article: null,
      userErrors: [
        {
          field: ['article', 'image', 'fileId'],
          code: 'NOT_FOUND',
          message: "No such image among the shop's files: a JPEG, PNG, WebP or GIF uploaded",
        },
      ],
    });
    const created = await gql(writer, CREATE_ARTICLE, {
      article: {
        blogId: blog,
        title: 'Eid lawn',
        image: { fileId: photo, altText: 'Lawn, folded' },
      },
    });
    const article = created.data!.articleCreate.article;
    expect(article.image).toEqual({ fileId: photo, altText: 'Lawn, folded' });
    const articleId = fromPublicId(article.id as string, 'article');
    // Served at the API's own address, read as the shop, while the article is published.
    const served = await call('GET', `/article-images/${shop}/${articleId}`);
    expect([
      served.statusCode,
      served.headers['content-type'],
      served.headers['cache-control'],
    ]).toEqual([200, 'image/png', 'public, max-age=3600']);
    expect(served.rawPayload.equals(png(96))).toBe(true);
    const UPDATE_ARTICLE = `mutation ($id: ID!, $article: ArticleUpdateInput!) {
      articleUpdate(id: $id, article: $article) {
        article { image { fileId altText } }
        userErrors { field message }
      }
    }`;
    await gql(writer, UPDATE_ARTICLE, { id: article.id, article: { isPublished: false } });
    expect((await call('GET', `/article-images/${shop}/${articleId}`)).statusCode).toBe(404);
    // Taken off, it is served no more, nor anything at an address naming nothing.
    const removed = await gql(writer, UPDATE_ARTICLE, {
      id: article.id,
      article: { isPublished: true, image: null },
    });
    expect(removed.data!.articleUpdate).toEqual({ article: { image: null }, userErrors: [] });
    for (const path of [
      `/article-images/${shop}/${articleId}`,
      `/article-images/${shop}/${newId()}`,
      `/article-images/${newId()}/${articleId}`,
      '/article-images/zari/eid',
    ]) {
      const answer = await call('GET', path);
      expect([answer.statusCode, answer.headers['cache-control']], path).toEqual([
        404,
        'public, max-age=60',
      ]);
    }
  });

  it('says what is wrong with an upload', async () => {
    const refused = await gql(tokens.owner, STAGE, {
      input: [{ filename: 'page.html', mimeType: 'text/html', fileSize: '64' }],
    });
    expect(refused.data?.stagedUploadsCreate).toEqual({
      stagedTargets: null,
      userErrors: [
        {
          field: ['input', '0', 'mimeType'],
          code: 'INVALID',
          message:
            'Upload one of image/jpeg, image/png, image/webp, image/gif, application/pdf; not ' +
            'text/html',
        },
      ],
    });
    const [target] = (
      await gql(tokens.owner, STAGE, {
        input: [{ filename: 'a.png', mimeType: 'image/png', fileSize: '64' }],
      })
    ).data!.stagedUploadsCreate.stagedTargets;
    const early = await gql(tokens.owner, CREATE, {
      files: [{ originalSource: target.resourceUrl }],
    });
    expect(early.data?.fileCreate.userErrors).toEqual([
      {
        field: ['files', '0', 'originalSource'],
        code: 'INVALID',
        message: 'Nothing has been uploaded to its URL yet',
      },
    ]);
  });
});
