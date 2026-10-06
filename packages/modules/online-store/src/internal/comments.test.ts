import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMMENT_LIMITS, commentHtml } from './comment.service.js';
import { comments } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

describe('Comment HTML', () => {
  it("shows a comment's text as typed: escaped, its paragraphs and lines kept", () => {
    expect(commentHtml('Lovely <b>lawn</b> & "fit"\nWill order again.\n\n\nThanks!')).toBe(
      '<p>Lovely &lt;b&gt;lawn&lt;/b&gt; &amp; &quot;fit&quot;<br>Will order again.</p>' +
        '<p>Thanks!</p>',
    );
    expect(commentHtml("It's <script>x()</script>")).toBe(
      '<p>It&#39;s &lt;script&gt;x()&lt;/script&gt;</p>',
    );
  });
});

describe.skipIf(!server)('Comments on articles (ADR-220)', () => {
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
    (await f.outbox())
      .filter((event) => event.event_type.startsWith('comment.'))
      .map((event) => [event.event_type, event.payload] as const);

  /** A blog with a published article, Eid, and a hidden one, Draft. */
  async function blogWithArticles(shop = f.a) {
    const blog = unwrap(await f.blogs.create(shop, { title: 'News' }));
    const eid = unwrap(await f.articles.create(shop, { blogId: blog.id, title: 'Eid' }));
    const draft = unwrap(
      await f.articles.create(shop, { blogId: blog.id, title: 'Draft', isPublished: false }),
    );
    return { blog, eid, draft };
  }

  const POST = {
    blog: 'news',
    article: 'eid',
    author: ' Ayesha Khan ',
    email: 'ayesha@example.pk',
    body: 'Lovely lawn.\r\nWill order again.',
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
  };

  it("takes comments as the blog's policy says: none while closed, held or shown at once", async () => {
    const { blog, eid } = await blogWithArticles();
    // A new blog takes none, as on Shopify.
    expect(blog.commentPolicy).toBe('closed');
    expect(errorsOf(await f.comments.post(f.a.shopId, POST))).toEqual([
      ['article', 'INVALID', "This article doesn't take comments"],
    ]);

    // Moderated: held for the shop, the storefront told of nothing yet.
    const moderated = unwrap(await f.blogs.update(f.a, blog.id, { commentPolicy: 'moderated' }));
    expect(moderated.commentPolicy).toBe('moderated');
    const held = unwrap(await f.comments.post(f.a.shopId, POST));
    expect(held.status).toBe('pending');
    expect(await f.comments.get(f.a, held.id)).toMatchObject({
      articleId: eid.id,
      author: 'Ayesha Khan',
      email: 'ayesha@example.pk',
      body: 'Lovely lawn.\nWill order again.',
      status: 'pending',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      publishedAt: null,
    });
    const shown = () =>
      f.db.tenant(f.a.shopId, (tx) => f.comments.shownCommentsOf(tx, f.a.shopId, [eid.id]));
    expect(await shown()).toEqual(new Map());

    // Approved: shown, and since when.
    const approved = unwrap(await f.comments.approve(f.a, held.id));
    expect(approved.status).toBe('published');
    expect(approved.publishedAt).toBeInstanceOf(Date);

    // Shown at once where the blog publishes them automatically.
    unwrap(await f.blogs.update(f.a, blog.id, { commentPolicy: 'auto_published' }));
    const at = unwrap(
      await f.comments.post(f.a.shopId, { ...POST, author: 'Zara', body: 'Size guide, please.' }),
    );
    expect(at.status).toBe('published');
    expect(await shown()).toEqual(
      new Map([
        [
          eid.id,
          {
            count: 2,
            comments: [
              expect.objectContaining({ id: held.id, author: 'Ayesha Khan' }),
              expect.objectContaining({ id: at.id, author: 'Zara' }),
            ],
          },
        ],
      ]),
    );
    expect(await events()).toEqual([
      ['comment.created', { articleId: eid.id, status: 'pending', shown: false }],
      ['comment.updated', { articleId: eid.id, status: 'published', shown: true }],
      ['comment.created', { articleId: eid.id, status: 'published', shown: true }],
    ]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'blog.updated')
        .map((event) => event.payload),
    ).toEqual([
      { handle: 'news', changed: ['commentPolicy'] },
      { handle: 'news', changed: ['commentPolicy'] },
    ]);
    expect(
      errorsOf(await f.blogs.update(f.a, blog.id, { commentPolicy: 'open' as never })),
    ).toEqual([['commentPolicy', 'INVALID', 'Must be one of closed, moderated, auto_published']]);
  });

  it("refuses what is wrong with a comment, and articles the storefront doesn't show", async () => {
    const { blog } = await blogWithArticles();
    unwrap(await f.blogs.update(f.a, blog.id, { commentPolicy: 'auto_published' }));
    expect(
      errorsOf(
        await f.comments.post(f.a.shopId, {
          ...POST,
          author: ' ',
          email: 'not-an-address',
          body: 'x'.repeat(COMMENT_LIMITS.body + 1),
        }),
      ),
    ).toEqual([
      ['author', 'BLANK', "Author can't be blank"],
      ['email', 'INVALID', 'Email must be an email address, like name@example.com'],
      ['body', 'TOO_LONG', `Body is too long (maximum is ${COMMENT_LIMITS.body} characters)`],
    ]);
    // Control characters go; a body of nothing else is blank.
    const nul = String.fromCharCode(0);
    expect(
      errorsOf(await f.comments.post(f.a.shopId, { ...POST, email: '', body: `${nul} ` })),
    ).toEqual([
      ['email', 'BLANK', "Email can't be blank"],
      ['body', 'BLANK', "Body can't be blank"],
    ]);
    for (const where of [{ article: 'draft' }, { article: 'nothing' }, { blog: 'journal' }]) {
      expect(
        errorsOf(await f.comments.post(f.a.shopId, { ...POST, ...where })),
        where.article,
      ).toEqual([['article', 'NOT_FOUND', 'Article not found']]);
    }
    // Another shop's article of the same address is its own.
    expect(errorsOf(await f.comments.post(f.b.shopId, POST))).toEqual([
      ['article', 'NOT_FOUND', 'Article not found'],
    ]);
    // An address the storefront can't vouch for is not kept, nor a browser's name past its limit.
    const kept = unwrap(
      await f.comments.post(f.a.shopId, { ...POST, ip: 'proxy', userAgent: 'x'.repeat(600) }),
    );
    expect(await f.comments.get(f.a, kept.id)).toMatchObject({
      ip: null,
      userAgent: 'x'.repeat(COMMENT_LIMITS.userAgent),
    });
  });

  it('lists comments, marks them as spam or not, deletes them, and keeps shops apart', async () => {
    const { blog, eid, draft } = await blogWithArticles();
    unwrap(await f.blogs.update(f.a, blog.id, { commentPolicy: 'auto_published' }));
    // Comments on the draft, written before it was hidden, as an article taken down keeps them.
    await f.admin.query(
      `INSERT INTO online_store.comments (shop_id, article_id, author, email, body, status)
       VALUES ($1, $2, 'Old', 'old@example.pk', 'From before', 'pending')`,
      [f.a.shopId, draft.id],
    );
    const first = unwrap(await f.comments.post(f.a.shopId, { ...POST, author: 'First' }));
    const second = unwrap(await f.comments.post(f.a.shopId, { ...POST, author: 'Second' }));
    const authors = async (options: Parameters<typeof f.comments.list>[1]) =>
      (await f.comments.list(f.a, options)).items.map((comment) => comment.author);
    expect(await authors({ first: 10 })).toEqual(['Second', 'First', 'Old']);
    expect(await authors({ first: 10, status: 'pending' })).toEqual(['Old']);
    expect(await authors({ first: 10, articleId: eid.id })).toEqual(['Second', 'First']);
    const page = await f.comments.list(f.a, { first: 1 });
    expect(page.hasNextPage).toBe(true);
    expect(await authors({ first: 10, after: page.items[0]!.id })).toEqual(['First', 'Old']);
    expect(await f.comments.countsOf(f.a, [eid.id, draft.id, newId()])).toEqual(
      new Map([
        [eid.id, 2],
        [draft.id, 1],
      ]),
    );

    // Spam, then not: shown again since it was first; the same again changes nothing.
    await f.admin.query('DELETE FROM platform.outbox_events');
    const spam = unwrap(await f.comments.markSpam(f.a, first.id));
    expect(spam).toMatchObject({ status: 'spam' });
    const back = unwrap(await f.comments.markNotSpam(f.a, first.id));
    expect(back).toMatchObject({ status: 'published', publishedAt: spam.publishedAt });
    unwrap(await f.comments.approve(f.a, first.id));
    unwrap(await f.comments.delete(f.a, second.id));
    expect(errorsOf(await f.comments.delete(f.a, second.id))).toEqual([
      ['id', 'NOT_FOUND', 'Comment not found'],
    ]);
    expect(await events()).toEqual([
      ['comment.updated', { articleId: eid.id, status: 'spam', shown: true }],
      ['comment.updated', { articleId: eid.id, status: 'published', shown: true }],
      ['comment.deleted', { articleId: eid.id, status: 'published', shown: true }],
    ]);

    // Another shop sees none of them, nor changes them.
    expect(await f.comments.get(f.b, first.id)).toBeNull();
    expect((await f.comments.list(f.b, { first: 10 })).items).toEqual([]);
    expect(errorsOf(await f.comments.approve(f.b, first.id))).toEqual([
      ['id', 'NOT_FOUND', 'Comment not found'],
    ]);
    // An article deleted takes its comments with it.
    unwrap(await f.articles.delete(f.a, eid.id));
    const left = await f.db.tenant(f.a.shopId, (tx) => tx.select().from(comments));
    expect(left.map((row) => row.author)).toEqual(['Old']);
  });
});
