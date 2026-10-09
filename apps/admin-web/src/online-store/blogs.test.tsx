import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const EARLIER = '2026-01-05T09:00:00Z';
const STORAGE = 'https://storage.hatti.test/s/zari/photo';

const NEWS = {
  id: 'blg_1',
  title: 'News',
  handle: 'news',
  commentPolicy: 'MODERATED',
  articlesCount: 3,
};

const ARTICLES = [
  {
    id: 'art_1',
    title: 'Eid lawn is here',
    handle: 'eid-lawn',
    isPublished: true,
    publishedAt: EARLIER,
    commentsCount: 3,
  },
  {
    id: 'art_2',
    title: 'Winter shawls',
    handle: 'winter-shawls',
    isPublished: false,
    publishedAt: LATER,
    commentsCount: 0,
  },
  {
    id: 'art_3',
    title: 'Notes',
    handle: 'notes',
    isPublished: false,
    publishedAt: null,
    commentsCount: 0,
  },
];

const comment = (id: string, status: string, name: string) => ({
  id,
  body: `${name} says hello`,
  status,
  createdAt: EARLIER,
  author: { name, email: `${name.toLowerCase()}@mail.pk` },
});

const ARTICLE = {
  ...ARTICLES[0],
  body: '<p>Our Eid lawn is in the shop.</p>',
  summary: null,
  tags: ['eid', 'lawn'],
  author: { name: 'Sana' },
  image: { fileId: 'fil_2', altText: 'Eid lawn is here' },
  blog: { id: 'blg_1', title: 'News', handle: 'news', commentPolicy: 'MODERATED' },
  comments: {
    nodes: [
      comment('cmt_1', 'PENDING', 'Ayesha'),
      comment('cmt_2', 'PUBLISHED', 'Bilal'),
      comment('cmt_3', 'SPAM', 'Spammer'),
    ],
  },
};

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Blogs':
        return { blogs: { nodes: [NEWS] } };
      case 'Blog':
        return { blog: { ...NEWS, id: variables.id, articles: { nodes: ARTICLES } } };
      case 'BlogCreate':
        return { blogCreate: { blog: { id: 'blg_9' }, userErrors: [] } };
      case 'BlogUpdate':
        return { blogUpdate: { blog: { id: variables.id }, userErrors: [] } };
      case 'BlogDelete':
        return { blogDelete: { deletedBlogId: variables.id, userErrors: [] } };
      case 'Article':
        return { article: ARTICLE };
      case 'ShopFile':
        return { file: { id: 'fil_2', url: `${STORAGE}/eid.jpg`, alt: 'Image' } };
      case 'StagedUploadsCreate':
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: `${STORAGE}?expires=1&signature=s`,
                httpMethod: 'PUT',
                resourceUrl: STORAGE,
                parameters: [{ name: 'content-type', value: 'image/png' }],
              },
            ],
            userErrors: [],
          },
        };
      case 'FileCreate':
        return { fileCreate: { files: [{ id: 'fil_1' }], userErrors: [] } };
      case 'ArticleCreate':
        return { articleCreate: { article: { id: 'art_9' }, userErrors: [] } };
      case 'ArticleUpdate':
        return { articleUpdate: { article: { id: variables.id }, userErrors: [] } };
      case 'ArticleDelete':
        return { articleDelete: { deletedArticleId: variables.id, userErrors: [] } };
      case 'CommentApprove':
        return { commentApprove: { comment: { id: variables.id }, userErrors: [] } };
      case 'CommentSpam':
        return { commentSpam: { comment: { id: variables.id }, userErrors: [] } };
      case 'CommentNotSpam':
        return { commentNotSpam: { comment: { id: variables.id }, userErrors: [] } };
      case 'CommentDelete':
        return { commentDelete: { deletedCommentId: variables.id, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe("The online store's blogs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts a blog, and writes an article with an image to show from a time ahead', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/shop_1/online-store?tab=blogs');

    expect((await screen.findByRole('link', { name: /News/ })).textContent).toContain('3 articles');
    type('New blog', 'Style tips');
    fireEvent.click(screen.getByRole('button', { name: 'Start the blog' }));
    await waitFor(() =>
      expect(sentOf(fake, 'BlogCreate')).toEqual({ blog: { title: 'Style tips' } }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/shop_1/online-store/blogs/blg_9'),
    );

    const articles = await screen.findByRole('region', { name: 'Articles' });
    expect(within(articles).getByRole('link', { name: /Eid lawn is here/ }).textContent).toContain(
      '3 comments',
    );
    expect(within(articles).getByRole('link', { name: /Winter shawls/ }).textContent).toContain(
      'Shows from',
    );
    expect(within(articles).getByRole('link', { name: /Notes/ }).textContent).toContain('Hidden');
    fireEvent.click(within(articles).getByRole('link', { name: 'Write an article' }));

    await screen.findByRole('heading', { name: 'Write an article' });
    type('Title', 'Lawn care');
    type('Article', 'Wash it cold.\n\n- Dry in shade\n- Iron inside out');
    type('Author', 'Sana');
    type('Tags', 'lawn, care ,');
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Image', { selector: 'input' }), {
        target: { files: [new File([new Uint8Array(4)], 'lawn.png', { type: 'image/png' })] },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Replace the image' })).toBeTruthy();
    expect(sentOf(fake, 'FileCreate')).toEqual({
      files: [{ originalSource: STORAGE, alt: 'Image' }],
    });
    fireEvent.click(screen.getByLabelText('Show it from a time ahead'));
    expect(
      (screen.getByRole('button', { name: 'Publish the article' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    type('Show from', '2026-12-01T10:00');
    fireEvent.click(screen.getByRole('button', { name: 'Publish the article' }));

    await waitFor(() =>
      expect(sentOf(fake, 'ArticleCreate')).toEqual({
        article: {
          blogId: 'blg_9',
          title: 'Lawn care',
          body: '<p>Wash it cold.</p>\n<ul>\n<li>Dry in shade</li>\n<li>Iron inside out</li>\n</ul>',
          author: { name: 'Sana' },
          tags: ['lawn', 'care'],
          image: { fileId: 'fil_1', altText: 'Lawn care' },
          isPublished: true,
          publishDate: new Date('2026-12-01T10:00').toISOString(),
        },
      }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/shop_1/online-store/articles/art_9'),
    );
  });

  it('changes an article, moderates its comments, and deletes it', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/shop_1/online-store/articles/art_1');

    expect(((await screen.findByAltText('Image')) as HTMLImageElement).src).toBe(
      `${STORAGE}/eid.jpg`,
    );
    const comments = screen.getByRole('region', { name: 'Comments' });
    expect(within(comments).getByText('1 comment waits for you to approve it.')).toBeTruthy();
    const row = (name: string) => within(comments).getByText(name).closest('li')!;
    fireEvent.click(within(row('Ayesha')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sentOf(fake, 'CommentApprove')).toEqual({ id: 'cmt_1' }));
    fireEvent.click(within(row('Bilal')).getByRole('button', { name: 'Mark as spam' }));
    await waitFor(() => expect(sentOf(fake, 'CommentSpam')).toEqual({ id: 'cmt_2' }));
    expect(within(row('Spammer')).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(row('Spammer')).getByRole('button', { name: 'Not spam' }));
    await waitFor(() => expect(sentOf(fake, 'CommentNotSpam')).toEqual({ id: 'cmt_3' }));
    fireEvent.click(within(row('Spammer')).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(row('Spammer')).getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(fake, 'CommentDelete')).toEqual({ id: 'cmt_3' }));

    type('Title', 'Eid lawn has landed');
    fireEvent.click(screen.getByRole('button', { name: 'Take the image away' }));
    fireEvent.click(screen.getByLabelText('Keep it hidden'));
    fireEvent.click(screen.getByRole('button', { name: 'Save the article' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ArticleUpdate')).toEqual({
        id: 'art_1',
        article: { title: 'Eid lawn has landed', image: null, isPublished: false },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete the article' }));
    expect(screen.getByText(/Its comments are deleted with it/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete it' }).at(-1)!);
    await waitFor(() => expect(sentOf(fake, 'ArticleDelete')).toEqual({ id: 'art_1' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/shop_1/online-store/blogs/blg_1'),
    );
  });

  it("closes a blog's comments and deletes it, and leaves blogs to those who write content", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/shop_1/online-store/blogs/blg_1');

    fireEvent.click(await screen.findByLabelText(/No comments/));
    fireEvent.click(screen.getByRole('button', { name: 'Save the blog' }));
    await waitFor(() =>
      expect(sentOf(fake, 'BlogUpdate')).toEqual({
        id: 'blg_1',
        blog: { commentPolicy: 'CLOSED' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete the blog' }));
    expect(screen.getByText(/Its 3 articles and their comments are deleted with it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(fake, 'BlogDelete')).toEqual({ id: 'blg_1' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'blogs' }));
    cleanup();

    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/online-store/blogs/blg_1');
    expect(await screen.findByText("Your role does not write the shop's pages.")).toBeTruthy();
  });
});
