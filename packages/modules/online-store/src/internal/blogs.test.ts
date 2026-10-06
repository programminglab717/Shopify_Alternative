import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishedArticleImageOf } from './article.service.js';
import { searchContentIn } from './content-search.js';
import { REDIRECT_LIMIT } from './redirect-paths.js';
import { articles, blogs } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';
import { shopRedirectsOf } from './url-redirect.service.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Blogs and their articles (ADR-176)', () => {
  let f: OnlineStoreFixture;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const events = async () =>
    (await f.outbox()).map((event) => [event.event_type, event.payload] as const);
  const redirects = () => f.db.tenant(f.a.shopId, (tx) => shopRedirectsOf(tx, f.a.shopId));

  it('matches the migrated tables', async () => {
    await f.db.tenant(f.a.shopId, async (tx) => {
      await tx.select().from(blogs).limit(1);
      await tx.select().from(articles).limit(1);
    });
  });

  it('keeps a blog with a handle from its title, each its own, and changes it', async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News & Updates' }));
    expect(news).toMatchObject({ handle: 'news-and-updates', templateSuffix: null });
    expect(await f.blogs.get(f.a, news.id)).toEqual(news);
    expect(await f.blogs.get(f.b, news.id)).toBeNull();
    const urdu = unwrap(await f.blogs.create(f.a, { title: 'خبریں' }));
    expect(urdu.handle).toBe('blog');
    expect(
      errorsOf(await f.blogs.create(f.a, { title: 'More', handle: 'News & Updates' })),
    ).toEqual([['handle', 'TAKEN', 'Handle "news-and-updates" is another blog\'s']]);
    expect(
      errorsOf(await f.blogs.create(f.a, { title: ' ', handle: '---', templateSuffix: 'A B' })),
    ).toEqual([
      ['title', 'BLANK', "Title can't be blank"],
      ['handle', 'INVALID', 'Handle must contain letters or digits'],
      ['templateSuffix', 'INVALID', expect.stringContaining('may have only lower-case letters')],
    ]);

    // Its old address sends shoppers on when asked; nothing changes, nothing is said.
    const renamed = unwrap(
      await f.blogs.update(f.a, news.id, {
        title: 'News',
        handle: 'news',
        templateSuffix: 'news',
        redirectNewHandle: true,
      }),
    );
    expect(renamed).toMatchObject({ title: 'News', handle: 'news', templateSuffix: 'news' });
    unwrap(await f.blogs.update(f.a, news.id, { title: 'News' }));
    expect(await redirects()).toEqual([{ path: '/blogs/news-and-updates', target: '/blogs/news' }]);
    expect(errorsOf(await f.blogs.update(f.a, urdu.id, { handle: 'news' }))).toEqual([
      ['handle', 'TAKEN', 'Handle "news" is another blog\'s'],
    ]);
    expect(errorsOf(await f.blogs.update(f.a, newId(), { title: 'Gone' }))).toEqual([
      ['id', 'NOT_FOUND', 'Blog not found'],
    ]);
    expect((await events()).filter(([type]) => type.startsWith('blog.'))).toEqual([
      ['blog.created', { handle: 'news-and-updates' }],
      ['blog.created', { handle: 'blog' }],
      ['blog.updated', { handle: 'news', changed: ['title', 'handle', 'templateSuffix'] }],
    ]);
  });

  it("keeps an article's title and description for search engines (ADR-231)", async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const eid = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Eid collection is here',
        seo: { title: 'Eid lawn 2026', description: 'Hand-block printed lawn for Eid.' },
      }),
    );
    expect(eid.seo).toEqual({
      title: 'Eid lawn 2026',
      description: 'Hand-block printed lawn for Eid.',
    });
    expect(await f.articles.get(f.a, eid.id)).toEqual(eid);
    // A blank title gives it its own again; the description stays.
    const retitled = unwrap(await f.articles.update(f.a, eid.id, { seo: { title: ' ' } }));
    expect(retitled.seo).toEqual({ title: null, description: 'Hand-block printed lawn for Eid.' });
    expect((await f.outbox()).at(-1)?.payload).toMatchObject({ changed: ['seoTitle'] });
  });

  it("keeps a blog's title and description for search engines (ADR-244)", async () => {
    const news = unwrap(
      await f.blogs.create(f.a, {
        title: 'News',
        seo: { title: 'The Zari journal', description: 'Eid edits\nand lawn launches.' },
      }),
    );
    // Each on one line.
    expect(news.seo).toEqual({
      title: 'The Zari journal',
      description: 'Eid edits and lawn launches.',
    });
    expect(await f.blogs.get(f.a, news.id)).toEqual(news);
    // A blank title gives it its own again; the description stays.
    const retitled = unwrap(await f.blogs.update(f.a, news.id, { seo: { title: ' ' } }));
    expect(retitled.seo).toEqual({ title: null, description: 'Eid edits and lawn launches.' });
    expect((await f.outbox()).at(-1)?.payload).toEqual({ handle: 'news', changed: ['seoTitle'] });
    // Null clears both; too long is refused.
    const cleared = unwrap(await f.blogs.update(f.a, news.id, { seo: null }));
    expect(cleared.seo).toEqual({ title: null, description: null });
    expect(
      errorsOf(await f.blogs.update(f.a, news.id, { seo: { title: 'x'.repeat(256) } })),
    ).toEqual([['seo.title', 'TOO_LONG', 'SEO title is too long (maximum is 255 characters)']]);
  });

  it('keeps an article in its blog, its HTML cleaned, its handle its blog’s alone', async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const recipes = unwrap(await f.blogs.create(f.a, { title: 'Recipes' }));
    const written = new Date('2025-12-01T09:00:00Z');
    const eid = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Eid collection is here',
        body: '<h2>New lawn</h2><p onclick="x()">Hand-block printed.<script>x()</script></p>',
        summary: '<p>Our Eid lawn, <iframe src="//x"></iframe>out now.</p>',
        author: ' Ayesha Khan ',
        tags: [' Eid ', 'lawn', 'EID', ''],
        publishDate: written,
      }),
    );
    expect(eid).toMatchObject({
      blogId: news.id,
      handle: 'eid-collection-is-here',
      body: '<h2>New lawn</h2><p>Hand-block printed.</p>',
      summary: '<p>Our Eid lawn, out now.</p>',
      author: 'Ayesha Khan',
      tags: ['Eid', 'lawn'],
      isPublished: true,
      publishedAt: written,
      templateSuffix: null,
    });
    expect(await f.articles.get(f.a, eid.id)).toEqual(eid);
    expect(await f.articles.get(f.b, eid.id)).toBeNull();
    // The same handle in another blog is another address; not in the same blog.
    const draft = unwrap(
      await f.articles.create(f.a, {
        blogId: recipes.id,
        title: 'Eid collection is here',
        isPublished: false,
      }),
    );
    expect(draft).toMatchObject({
      handle: 'eid-collection-is-here',
      isPublished: false,
      publishedAt: null,
      author: '',
      summary: '',
      tags: [],
    });
    expect(
      errorsOf(
        await f.articles.create(f.a, {
          blogId: news.id,
          title: 'Again',
          handle: 'eid-collection-is-here',
        }),
      ),
    ).toEqual([
      ['handle', 'TAKEN', 'Handle "eid-collection-is-here" is another article\'s in its blog'],
    ]);
    expect(
      errorsOf(
        await f.articles.create(f.a, {
          blogId: news.id,
          title: '',
          summary: `<p>${'x'.repeat(70_000)}</p>`,
          author: 'x'.repeat(256),
          publishDate: new Date(Date.now() + 400 * 86_400_000),
        }),
      ),
    ).toEqual([
      ['title', 'BLANK', "Title can't be blank"],
      ['summary', 'TOO_LONG', 'Summary is too long (maximum is 64 KB)'],
      ['author', 'TOO_LONG', 'Author is too long (maximum is 255 characters)'],
      ['publishDate', 'INVALID', "Publish date can't be more than a year ahead"],
    ]);
    // Another shop's blog is none to write in.
    expect(errorsOf(await f.articles.create(f.b, { blogId: news.id, title: 'Mine' }))).toEqual([
      ['blogId', 'NOT_FOUND', 'Blog not found'],
    ]);
    expect((await events()).filter(([type]) => type.startsWith('article.'))).toEqual([
      ['article.created', { blogId: news.id, handle: 'eid-collection-is-here', isPublished: true }],
      [
        'article.created',
        { blogId: recipes.id, handle: 'eid-collection-is-here', isPublished: false },
      ],
    ]);
  });

  it('changes an article, saying what changed, and moves it to another blog with its address', async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const guides = unwrap(await f.blogs.create(f.a, { title: 'Guides' }));
    const article = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Sizes',
        tags: ['fit'],
        isPublished: false,
      }),
    );
    const shown = unwrap(
      await f.articles.update(f.a, article.id, {
        body: '<p>Measure twice.</p>',
        author: 'Zara',
        tags: ['fit', 'sizes'],
        isPublished: true,
      }),
    );
    expect(shown).toMatchObject({ author: 'Zara', tags: ['fit', 'sizes'], isPublished: true });
    expect(shown.publishedAt).toBeInstanceOf(Date);
    // Nothing changed: nothing said.
    unwrap(await f.articles.update(f.a, article.id, { author: 'Zara', tags: ['fit', 'sizes'] }));
    const moved = unwrap(
      await f.articles.update(f.a, article.id, {
        blogId: guides.id,
        handle: 'size-guide',
        publishDate: new Date('2026-01-01T00:00:00Z'),
        redirectNewHandle: true,
      }),
    );
    expect(moved).toMatchObject({ blogId: guides.id, handle: 'size-guide' });
    expect(moved.publishedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(await redirects()).toEqual([
      { path: '/blogs/news/sizes', target: '/blogs/guides/size-guide' },
    ]);
    const updates = (await events()).filter(([type]) => type === 'article.updated');
    expect(updates).toEqual([
      [
        'article.updated',
        {
          blogId: news.id,
          handle: 'sizes',
          isPublished: true,
          changed: ['body', 'author', 'tags', 'isPublished'],
          previousBlogId: null,
        },
      ],
      [
        'article.updated',
        {
          blogId: guides.id,
          handle: 'size-guide',
          isPublished: true,
          changed: ['handle', 'publishedAt', 'blogId'],
          previousBlogId: news.id,
        },
      ],
    ]);
    // A handle its new blog has is refused; so is a blog not there.
    unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Size guide' }));
    expect(
      errorsOf(await f.articles.update(f.a, article.id, { blogId: news.id }))[0]?.slice(0, 2),
    ).toEqual(['handle', 'TAKEN']);
    expect(errorsOf(await f.articles.update(f.a, article.id, { blogId: newId() }))).toEqual([
      ['blogId', 'NOT_FOUND', 'Blog not found'],
    ]);
    expect(errorsOf(await f.articles.update(f.a, newId(), { title: 'Gone' }))).toEqual([
      ['id', 'NOT_FOUND', 'Article not found'],
    ]);
  });

  it("sends a blog's articles' old addresses to their new ones when asked, as Shopify's redirectArticles (ADR-218)", async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const at = (day: string) => new Date(`2026-${day}T09:00:00Z`);
    unwrap(
      await f.articles.create(f.a, { blogId: news.id, title: 'Eid', publishDate: at('03-01') }),
    );
    unwrap(
      await f.articles.create(f.a, { blogId: news.id, title: 'Lawn', publishDate: at('04-01') }),
    );
    unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Draft', isPublished: false }));
    // Another blog's articles stay where they are.
    const guides = unwrap(await f.blogs.create(f.a, { title: 'Guides' }));
    unwrap(await f.articles.create(f.a, { blogId: guides.id, title: 'Sizes' }));
    await f.admin.query('DELETE FROM platform.outbox_events');

    // Not asked: nothing sends shoppers on.
    unwrap(await f.blogs.update(f.a, news.id, { handle: 'updates' }));
    expect(await redirects()).toEqual([]);
    unwrap(await f.blogs.update(f.a, news.id, { handle: 'journal', redirectArticles: true }));
    expect(await redirects()).toEqual([
      { path: '/blogs/updates/draft', target: '/blogs/journal/draft' },
      { path: '/blogs/updates/eid', target: '/blogs/journal/eid' },
      { path: '/blogs/updates/lawn', target: '/blogs/journal/lawn' },
    ]);
    // With its own address too; the older addresses go straight to the newest.
    unwrap(
      await f.blogs.update(f.a, news.id, {
        handle: 'stories',
        redirectNewHandle: true,
        redirectArticles: true,
      }),
    );
    expect(await redirects()).toEqual([
      { path: '/blogs/journal', target: '/blogs/stories' },
      { path: '/blogs/journal/draft', target: '/blogs/stories/draft' },
      { path: '/blogs/journal/eid', target: '/blogs/stories/eid' },
      { path: '/blogs/journal/lawn', target: '/blogs/stories/lawn' },
      { path: '/blogs/updates/draft', target: '/blogs/stories/draft' },
      { path: '/blogs/updates/eid', target: '/blogs/stories/eid' },
      { path: '/blogs/updates/lawn', target: '/blogs/stories/lawn' },
    ]);
    // The storefront told once for the articles each time.
    expect((await events()).filter(([type]) => type.startsWith('url_redirect'))).toEqual([
      ['url_redirects.moved', { created: 3, updated: 0, deleted: 0 }],
      ['url_redirect.created', { path: '/blogs/journal', target: '/blogs/stories' }],
      ['url_redirects.moved', { created: 3, updated: 3, deleted: 0 }],
    ]);

    // A shop with room for one more redirect gets its latest published article's.
    await f.admin.query('DELETE FROM online_store.url_redirects WHERE shop_id = $1', [f.a.shopId]);
    await f.admin.query(
      `INSERT INTO online_store.url_redirects (shop_id, path, target)
       SELECT $1, '/old-' || n, '/' FROM generate_series(1, $2) AS n`,
      [f.a.shopId, REDIRECT_LIMIT - 1],
    );
    unwrap(await f.blogs.update(f.a, news.id, { handle: 'posts', redirectArticles: true }));
    expect((await redirects()).filter((r) => r.path.startsWith('/blogs/'))).toEqual([
      { path: '/blogs/stories/lawn', target: '/blogs/posts/lawn' },
    ]);
  });

  it("keeps an article's image, one of the shop's images ready to show, and says it changed (ADR-213)", async () => {
    const file = async (shopId: string, contentType: string, status = 'ready') => {
      const id = newId();
      await f.admin.query(
        `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status)
         VALUES ($1, $2, $3, 'file', $4, 64, $5)`,
        [shopId, id, `shops/${shopId}/files/${id}/file`, contentType, status],
      );
      return id;
    };
    const photo = await file(f.a.shopId, 'image/webp');
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const article = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Eid lawn',
        image: { fileId: photo, altText: ' Lawn, folded ' },
      }),
    );
    expect(article.image).toEqual({ fileId: photo, altText: 'Lawn, folded' });
    expect(await f.articles.get(f.a, article.id)).toEqual(article);
    const shown = () =>
      f.db.tenant(f.a.shopId, (tx) => publishedArticleImageOf(tx, f.a.shopId, article.id));
    expect(await shown()).toEqual(article.image);

    // Not a file a page can show: another kind, one not yet uploaded, another shop's, none.
    const others = [
      await file(f.a.shopId, 'application/pdf'),
      await file(f.a.shopId, 'image/png', 'staged'),
      await file(f.b.shopId, 'image/png'),
      newId(),
      'not-an-id',
    ];
    for (const fileId of others) {
      expect(
        errorsOf(
          await f.articles.create(f.a, { blogId: news.id, title: 'Eid', image: { fileId } }),
        ),
        fileId,
      ).toEqual([
        [
          'image.fileId',
          'NOT_FOUND',
          "No such image among the shop's files: a JPEG, PNG, WebP or GIF uploaded",
        ],
      ]);
    }
    expect(
      errorsOf(
        await f.articles.update(f.a, article.id, {
          image: { fileId: photo, altText: 'x'.repeat(513) },
        }),
      ).map(([field, code]) => [field, code]),
    ).toEqual([['image.altText', 'TOO_LONG']]);

    // Its alt text changed, then the same again, which says nothing; then none.
    const plain = unwrap(await f.articles.update(f.a, article.id, { image: { fileId: photo } }));
    expect(plain.image).toEqual({ fileId: photo, altText: '' });
    unwrap(await f.articles.update(f.a, article.id, { image: { fileId: photo, altText: '' } }));
    unwrap(await f.articles.update(f.a, article.id, { isPublished: false }));
    expect(await shown()).toBeNull();
    unwrap(await f.articles.update(f.a, article.id, { isPublished: true }));
    expect(await shown()).toEqual(plain.image);
    expect(unwrap(await f.articles.update(f.a, article.id, { image: null })).image).toBeNull();
    expect(await shown()).toBeNull();
    const changed = (await events())
      .filter(([type]) => type === 'article.updated')
      .map(([, payload]) => (payload as { changed: string[] }).changed);
    expect(changed).toEqual([['image'], ['isPublished'], ['isPublished'], ['image']]);
  });

  it('publishes an article at a time ahead, hidden until then and shown once by the worker (ADR-215)', async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const tomorrow = new Date(Math.ceil(Date.now() / 1000) * 1000 + 86_400_000);
    const eid = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Eid sale begins',
        body: '<p>Lawn at half price.</p>',
        publishDate: tomorrow,
      }),
    );
    expect(eid).toMatchObject({ isPublished: false, publishedAt: tomorrow });
    // Hidden until then: from its blog's page, the read models and the storefront's search.
    const seen = () =>
      f.db.tenant(f.a.shopId, async (tx) => ({
        listed: (await f.articles.publishedIn(tx, f.a.shopId, [news.id])).map((each) => each.id),
        read: (await f.articles.articlesOf(tx, f.a.shopId, { published: true })).map(
          (each) => each.id,
        ),
        found: (await searchContentIn(tx, f.a.shopId, 'lawn', { limit: 10 })).articleIds,
      }));
    expect(await seen()).toEqual({ listed: [], read: [], found: [] });
    expect(await f.articles.shopsWithArticlesDue()).not.toContain(f.a.shopId);
    expect(await f.articles.showDue(f.a.shopId)).toBe(0);

    // Its time come: shown, the worker saying so once.
    await f.admin.query(
      "UPDATE online_store.articles SET published_at = now() - interval '1 minute' WHERE id = $1",
      [eid.id],
    );
    expect((await f.articles.get(f.a, eid.id))?.isPublished).toBe(true);
    expect(await f.articles.shopsWithArticlesDue()).toContain(f.a.shopId);
    expect(await f.articles.showDue(f.a.shopId)).toBe(1);
    expect(await f.articles.showDue(f.a.shopId)).toBe(0);
    expect(await seen()).toEqual({ listed: [eid.id], read: [eid.id], found: [eid.id] });

    // Moved ahead, hidden, scheduled again, kept as it is, and shown now.
    const updates = async (input: Parameters<typeof f.articles.update>[2]) => {
      const before = (await events()).length;
      const record = unwrap(await f.articles.update(f.a, eid.id, input));
      const said = (await events())
        .slice(before)
        .map(([, payload]) => payload as { isPublished: boolean; changed: string[] });
      return { isPublished: record.isPublished, said };
    };
    expect(await updates({ publishDate: tomorrow })).toEqual({
      isPublished: false,
      said: [
        expect.objectContaining({ isPublished: false, changed: ['isPublished', 'publishedAt'] }),
      ],
    });
    expect(await updates({ isPublished: false })).toEqual({
      isPublished: false,
      said: [expect.objectContaining({ isPublished: false, changed: ['publishedAt'] })],
    });
    expect(await updates({ isPublished: true, publishDate: tomorrow })).toEqual({
      isPublished: false,
      said: [expect.objectContaining({ isPublished: false, changed: ['publishedAt'] })],
    });
    expect(await updates({ isPublished: true })).toEqual({ isPublished: false, said: [] });
    expect(await updates({ publishDate: new Date('2026-01-01T00:00:00Z') })).toEqual({
      isPublished: true,
      said: [
        expect.objectContaining({ isPublished: true, changed: ['isPublished', 'publishedAt'] }),
      ],
    });
    expect(await f.articles.showDue(f.a.shopId)).toBe(0);

    // A client's clock a little fast publishes now; more than a year ahead is refused.
    const soon = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Now',
        publishDate: new Date(Date.now() + 30_000),
      }),
    );
    expect(soon.isPublished).toBe(true);
    expect(
      errorsOf(
        await f.articles.update(f.a, eid.id, {
          publishDate: new Date(Date.now() + 367 * 86_400_000),
        }),
      ),
    ).toEqual([['publishDate', 'INVALID', "Publish date can't be more than a year ahead"]]);
  });

  it('deletes an article, and a blog with its articles, saying so', async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const first = unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'One' }));
    const second = unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Two' }));
    expect(unwrap(await f.articles.delete(f.a, first.id))).toEqual({ id: first.id });
    expect(errorsOf(await f.articles.delete(f.a, first.id))).toEqual([
      ['id', 'NOT_FOUND', 'Article not found'],
    ]);
    expect(unwrap(await f.blogs.delete(f.a, news.id))).toEqual({ id: news.id });
    expect(await f.articles.get(f.a, second.id)).toBeNull();
    expect(errorsOf(await f.blogs.delete(f.a, news.id))).toEqual([
      ['id', 'NOT_FOUND', 'Blog not found'],
    ]);
    expect((await events()).slice(-2)).toEqual([
      ['article.deleted', { blogId: news.id, handle: 'one', isPublished: true }],
      ['blog.deleted', { handle: 'news' }],
    ]);
  });

  it('lists blogs and articles a page at a time, counts them, and gives read models the latest first', async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const guides = unwrap(await f.blogs.create(f.a, { title: 'Guides' }));
    const old = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Old',
        publishDate: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    const hidden = unwrap(
      await f.articles.create(f.a, { blogId: news.id, title: 'Hidden', isPublished: false }),
    );
    const latest = unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Latest' }));
    const guide = unwrap(await f.articles.create(f.a, { blogId: guides.id, title: 'Guide' }));

    const page = await f.articles.list(f.a, { first: 2, blogId: news.id });
    expect([page.items.map((article) => article.title), page.hasNextPage]).toEqual([
      ['Old', 'Hidden'],
      true,
    ]);
    const next = await f.articles.list(f.a, { first: 2, after: hidden.id });
    expect(next.items.map((article) => article.title)).toEqual(['Latest', 'Guide']);
    expect((await f.blogs.list(f.a, { first: 1 })).items.map((blog) => blog.title)).toEqual([
      'News',
    ]);
    expect(await f.blogs.articleCounts(f.a, [news.id, guides.id, newId()])).toEqual(
      new Map([
        [news.id, 3],
        [guides.id, 1],
      ]),
    );
    expect([...(await f.blogs.byIds(f.a, [guides.id])).keys()]).toEqual([guides.id]);

    const ofNews = await f.db.tenant(f.a.shopId, (tx) =>
      f.articles.articlesOf(tx, f.a.shopId, { blogIds: [news.id] }),
    );
    expect(ofNews.map((article) => article.id)).toEqual([latest.id, old.id, hidden.id]);
    const published = await f.db.tenant(f.a.shopId, (tx) =>
      f.articles.articlesOf(tx, f.a.shopId, { published: true }),
    );
    expect(published.map((article) => article.id)).toEqual([guide.id, latest.id, old.id]);
    expect(await f.db.tenant(f.b.shopId, (tx) => f.articles.articlesOf(tx, f.b.shopId))).toEqual(
      [],
    );
  });
});
