import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

type Status = 'PENDING' | 'PUBLISHED' | 'HIDDEN';

function review(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    productId: 'prod_1',
    productTitle: 'Lawn suit',
    orderId: 'ord_31',
    authorName: 'Ayesha K.',
    rating: 4,
    body: 'Soft cloth, true colours.',
    status: 'PENDING',
    createdAt: LATER,
    updatedAt: LATER,
    publishedAt: null,
    ...extra,
  };
}

function core(
  role: StaffRole,
  pages: Partial<Record<Status, unknown[][]>> = {
    PENDING: [[review('rev_1'), review('rev_2', { rating: 2, body: null, authorName: 'Bilal' })]],
  },
  settings: { publishFrom: number | null; requestAfterDays: number | null } = {
    publishFrom: null,
    requestAfterDays: 7,
  },
) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'ProductReviews': {
        const status = variables.status as Status;
        return { productReviews: pages[status]?.[variables.after ? 1 : 0] ?? [] };
      }
      case 'ProductReviewPublish':
        return {
          productReviewPublish: {
            productReview: review(variables.id as string, { status: 'PUBLISHED' }),
            userErrors: [],
          },
        };
      case 'ProductReviewHide':
        return {
          productReviewHide: {
            productReview: null,
            userErrors: [
              { field: ['id'], code: 'NOT_FOUND', message: 'No review of the shop has this ID' },
            ],
          },
        };
      case 'ReviewSettings':
        return { reviewSettings: settings };
      case 'ReviewSettingsUpdate':
        return {
          reviewSettingsUpdate: { reviewSettings: variables.input, userErrors: [] },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Reviews (MKT-05, ADR-402)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the reviews waiting, with their product, stars, author, words and order', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/products/reviews');

    await screen.findByRole('heading', { name: 'Reviews' });
    expect(screen.getByRole('tab', { name: 'Waiting' }).getAttribute('aria-selected')).toBe('true');
    const [first, second] = await screen.findAllByRole('listitem');
    expect(within(first!).getByRole('link', { name: 'Lawn suit' }).getAttribute('href')).toBe(
      '/shop_1/products/prod_1',
    );
    expect(within(first!).getByRole('img', { name: '4 of 5 stars' })).toBeTruthy();
    expect(within(first!).getByText('Ayesha K.')).toBeTruthy();
    expect(within(first!).getByText('Soft cloth, true colours.')).toBeTruthy();
    expect(within(first!).getByRole('link', { name: 'Their order' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_31',
    );
    expect(within(second!).getByRole('img', { name: '2 of 5 stars' })).toBeTruthy();
    expect(within(second!).getByText('Stars alone, no words')).toBeTruthy();
    expect(within(first!).getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(within(first!).getByRole('button', { name: 'Hide' })).toBeTruthy();
  });

  it('publishes a review, and says why one could not be hidden', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/reviews');

    const [first, second] = await screen.findAllByRole('listitem');
    fireEvent.click(within(first!).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'ProductReviewPublish')?.variables,
      ).toEqual({ id: 'rev_1' }),
    );
    fireEvent.click(within(second!).getByRole('button', { name: 'Hide' }));
    expect(await within(second!).findByText(/No review of the shop has this ID/)).toBeTruthy();
  });

  it('shows each status on its own tab, with words when there are none', async () => {
    const fake = core('owner', {
      PENDING: [[]],
      PUBLISHED: [[review('rev_9', { status: 'PUBLISHED', authorName: 'Sana' })]],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/reviews');

    expect(await screen.findByText('No reviews are waiting for you')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Published' }));
    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('Sana')).toBeTruthy();
    expect(within(item).queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(within(item).getByRole('button', { name: 'Hide' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Hidden' }));
    expect(await screen.findByText('No reviews are hidden')).toBeTruthy();
  });

  it('pages through older reviews, fifty at a time', async () => {
    const first = Array.from({ length: 50 }, (_, index) => review(`rev_${index}`));
    const fake = core('owner', { PENDING: [first, [review('rev_old', { authorName: 'Zara' })]] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/reviews');

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }));
    expect(await screen.findByText('Zara')).toBeTruthy();
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'ProductReviews').at(-1)!.variables,
      ).toEqual({ first: 50, after: 'rev_49', status: 'PENDING' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    expect(await screen.findAllByText('Ayesha K.')).toHaveLength(50);
  });

  it('lets the owner choose how reviews publish and when customers are asked', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/reviews');

    const publish = (await screen.findByLabelText('Publish by themselves')) as HTMLSelectElement;
    const request = screen.getByLabelText('Ask for a review on WhatsApp') as HTMLSelectElement;
    await waitFor(() => expect(request.value).toBe('7'));
    expect(publish.value).toBe('');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(publish, { target: { value: '4' } });
    fireEvent.change(request, { target: { value: '' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'ReviewSettingsUpdate')?.variables,
      ).toEqual({ input: { publishFrom: 4, requestAfterDays: null } }),
    );
  });

  it('shows the settings to neither marketers nor agents, who may not publish either', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/reviews');

    await screen.findAllByRole('listitem');
    expect(screen.queryByLabelText('Publish by themselves')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull();
    expect(fake.sent.some((each) => each.operation === 'ReviewSettings')).toBe(false);
  });

  it('is linked from the products page', async () => {
    const fake = fakeCore('owner', (operation) => {
      if (operation === 'Products' || operation === 'ProductsSearch') {
        return { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return {};
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products');
    expect((await screen.findByRole('link', { name: 'Reviews' })).getAttribute('href')).toBe(
      '/shop_1/products/reviews',
    );
  });
});
