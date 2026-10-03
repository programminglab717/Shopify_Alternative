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

const ARTICLE_FIELDS =
  'id title handle body summary author { name } tags isPublished publishedAt templateSuffix ' +
  'blog { id handle }';

describe.skipIf(!server)('Admin GraphQL API: blogs and their articles (ADR-176)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', pages: '', b: '' };

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

  const createBlog = (token: string, blog: Record<string, unknown>) =>
    call(
      token,
      `mutation ($blog: BlogCreateInput!) {
        blogCreate(blog: $blog) { blog { id title handle templateSuffix } userErrors { field code message } }
      }`,
      { blog },
    );

  const createArticle = (token: string, article: Record<string, unknown>) =>
    call(
      token,
      `mutation ($article: ArticleCreateInput!) {
        articleCreate(article: $article) { article { ${ARTICLE_FIELDS} } userErrors { field code message } }
      }`,
      { article },
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_content']);
    tokens.reader = await issueToken(shopA, ['read_content']);
    tokens.pages = await issueToken(shopA, ['write_online_store_pages']);
    tokens.b = await issueToken(shopB, ['write_content']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('makes blogs and articles, their HTML cleaned, and changes, lists and deletes them', async () => {
    const news = await createBlog(tokens.a, { title: 'News' });
    expect(news).toEqual({
      blog: {
        id: expect.stringMatching(/^blog_[0-9a-z]{26}$/),
        title: 'News',
        handle: 'news',
        templateSuffix: null,
      },
      userErrors: [],
    });
    const created = await createArticle(tokens.a, {
      blogId: news.blog.id,
      title: 'Eid collection is here',
      body: '<p>Hand-block printed <b>lawn</b>.<script>steal()</script></p>',
      summary: '<p>Out now.</p>',
      author: { name: 'Ayesha Khan' },
      tags: ['Eid', 'lawn'],
      publishDate: '2025-12-01T09:00:00Z',
    });
    expect(created).toEqual({
      article: {
        id: expect.stringMatching(/^art_[0-9a-z]{26}$/),
        title: 'Eid collection is here',
        handle: 'eid-collection-is-here',
        body: '<p>Hand-block printed <b>lawn</b>.</p>',
        summary: '<p>Out now.</p>',
        author: { name: 'Ayesha Khan' },
        tags: ['Eid', 'lawn'],
        isPublished: true,
        publishedAt: '2025-12-01T09:00:00.000Z',
        templateSuffix: null,
        blog: { id: news.blog.id, handle: 'news' },
      },
      userErrors: [],
    });
    const draft = await createArticle(tokens.a, {
      blogId: news.blog.id,
      title: 'Coming soon',
      isPublished: false,
    });
    expect(draft.article).toMatchObject({
      summary: null,
      author: null,
      tags: [],
      isPublished: false,
      publishedAt: null,
    });

    const updated = await call(
      tokens.a,
      `mutation ($id: ID!, $article: ArticleUpdateInput!) {
        articleUpdate(id: $id, article: $article) {
          article { handle isPublished author { name } } userErrors { field code }
        }
      }`,
      { id: draft.article.id, article: { isPublished: true, author: { name: 'Zara' } } },
    );
    expect(updated).toEqual({
      article: { handle: 'coming-soon', isPublished: true, author: { name: 'Zara' } },
      userErrors: [],
    });
    const renamed = await call(
      tokens.a,
      `mutation ($id: ID!) {
        blogUpdate(id: $id, blog: { title: "Journal", handle: "journal", redirectNewHandle: true }) {
          blog { title handle } userErrors { field code }
        }
      }`,
      { id: news.blog.id },
    );
    expect(renamed).toEqual({ blog: { title: 'Journal', handle: 'journal' }, userErrors: [] });

    const blogs = await call(
      tokens.reader,
      `{ blogs(first: 5) { nodes { handle articlesCount articles(first: 1) { nodes { title } pageInfo { hasNextPage } } } } }`,
    );
    expect(blogs.nodes).toEqual([
      {
        handle: 'journal',
        articlesCount: 2,
        articles: { nodes: [{ title: 'Eid collection is here' }], pageInfo: { hasNextPage: true } },
      },
    ]);
    const first = await call(
      tokens.reader,
      `query ($blogId: ID) {
        articles(first: 1, blogId: $blogId) { nodes { title blog { handle } } pageInfo { hasNextPage endCursor } }
      }`,
      { blogId: news.blog.id },
    );
    expect(first.nodes).toEqual([{ title: 'Eid collection is here', blog: { handle: 'journal' } }]);
    const rest = await call(
      tokens.reader,
      `query ($after: String) { articles(first: 5, after: $after) { nodes { title } } }`,
      { after: first.pageInfo.endCursor },
    );
    expect(rest.nodes).toEqual([{ title: 'Coming soon' }]);
    expect(
      await call(tokens.reader, `{ article(id: "${created.article.id}") { handle } }`),
    ).toEqual({ handle: 'eid-collection-is-here' });

    const deleted = await call(
      tokens.a,
      `mutation ($id: ID!) { articleDelete(id: $id) { deletedArticleId userErrors { field code } } }`,
      { id: draft.article.id },
    );
    expect(deleted).toEqual({ deletedArticleId: draft.article.id, userErrors: [] });
    const gone = await call(
      tokens.a,
      `mutation ($id: ID!) { blogDelete(id: $id) { deletedBlogId userErrors { field code } } }`,
      { id: news.blog.id },
    );
    expect(gone).toEqual({ deletedBlogId: news.blog.id, userErrors: [] });
    // Its articles went with it.
    expect(await call(tokens.reader, `{ article(id: "${created.article.id}") { id } }`)).toBeNull();
  });

  it("says what is wrong under the blog's and the article's fields", async () => {
    const refused = await createBlog(tokens.a, { title: ' ', handle: '!!!' });
    expect(refused).toEqual({
      blog: null,
      userErrors: [
        { field: ['blog', 'title'], code: 'BLANK', message: "Title can't be blank" },
        {
          field: ['blog', 'handle'],
          code: 'INVALID',
          message: 'Handle must contain letters or digits',
        },
      ],
    });
    const blog = (await createBlog(tokens.a, { title: 'Guides' })).blog;
    const article = await createArticle(tokens.a, {
      blogId: blog.id,
      title: 'Sizes',
      publishDate: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(article).toEqual({
      article: null,
      userErrors: [
        {
          field: ['article', 'publishDate'],
          code: 'INVALID',
          message: "Publish date can't be in the future",
        },
      ],
    });
  });

  it('needs the content scopes, and keeps each shop to its own blogs', async () => {
    for (const [token, query] of [
      [tokens.pages, '{ blogs(first: 1) { nodes { id } } }'],
      [tokens.pages, '{ articles(first: 1) { nodes { id } } }'],
      [tokens.reader, 'mutation { blogCreate(blog: { title: "x" }) { blog { id } } }'],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
    const theirs = (await createBlog(tokens.b, { title: 'News' })).blog;
    expect(theirs.handle).toBe('news');
    expect(await call(tokens.reader, `{ blog(id: "${theirs.id}") { id } }`)).toBeNull();
    const update = await call(
      tokens.a,
      `mutation ($id: ID!) {
        blogUpdate(id: $id, blog: { title: "Mine" }) { blog { id } userErrors { field code } }
      }`,
      { id: theirs.id },
    );
    expect(update).toEqual({ blog: null, userErrors: [{ field: ['id'], code: 'NOT_FOUND' }] });
    // Nor may an article go in another shop's blog.
    const placed = await createArticle(tokens.a, { blogId: theirs.id, title: 'Mine' });
    expect(placed).toEqual({
      article: null,
      userErrors: [{ field: ['article', 'blogId'], code: 'NOT_FOUND', message: 'Blog not found' }],
    });
  });
});
