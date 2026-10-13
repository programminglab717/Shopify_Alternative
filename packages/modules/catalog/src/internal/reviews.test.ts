import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProductReviewService } from './review.service.js';
import {
  ReviewEvents,
  eraseReviewsIn,
  mergeReviewsIn,
  reviewAuthorName,
  reviewsOfCustomerIn,
  reviewsOfOrderIn,
  shownReviewsIn,
  writeReviewsIn,
  type ReviewInput,
} from './reviews.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe("A review's author, as the storefront names them (ADR-399)", () => {
  it('gives the first name and the surname\'s initial, or "A customer"', () => {
    expect(reviewAuthorName('Ayesha  khan')).toBe('Ayesha K.');
    expect(reviewAuthorName('Muhammad Ali Raza')).toBe('Muhammad R.');
    expect(reviewAuthorName('Bilal')).toBe('Bilal');
    expect(reviewAuthorName('عائشہ خان')).toBe('عائشہ خ.');
    expect(reviewAuthorName('  ')).toBe('A customer');
    expect(reviewAuthorName(null)).toBe('A customer');
  });
});

describe.skipIf(!server)("Products' reviews (MKT-05, ADR-399)", () => {
  let f: CatalogFixture;
  let reviews: ProductReviewService;
  let staff: TenantContext;
  const customerId = newId();

  /** Writes reviews as the customer of `orderId` would, on their order's page. */
  const write = (orderId: string, written: ReviewInput[], tenant = f.a) =>
    f.db.tenant(tenant.shopId, (tx) =>
      writeReviewsIn(
        tx,
        tenant.shopId,
        { id: orderId, customerId, authorName: 'Ayesha K.' },
        written,
      ),
    );
  const product = async (title: string) =>
    unwrap(await f.products.create(f.a, { title, status: 'active' })).id;

  beforeAll(async () => {
    f = await catalogFixture(server!);
    reviews = new ProductReviewService(f.db);
    staff = {
      ...f.a,
      scopes: new Set(['write_products', 'write_settings']),
      actor: {
        kind: 'staff',
        userId: newId(),
        sessionId: newId(),
        role: 'owner',
        authenticatedAt: new Date(),
      },
    };
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM catalog.review_settings');
  });

  it('keeps a review waiting for the shop, then published or hidden by it', async () => {
    const lawn = await product('Lawn Suit');
    const orderId = newId();
    expect(
      await write(orderId, [{ productId: lawn, rating: 4, body: '  Soft lawn, true colour ' }]),
    ).toBe(1);

    const [waiting] = await reviews.list(staff, { status: 'pending' });
    expect(waiting).toMatchObject({
      productId: lawn,
      productTitle: 'Lawn Suit',
      orderId,
      authorName: 'Ayesha K.',
      rating: 4,
      body: 'Soft lawn, true colour',
      status: 'pending',
      publishedAt: null,
    });
    expect(await reviews.list(staff, { status: 'published' })).toEqual([]);

    const published = unwrap(await reviews.moderate(staff, waiting!.id, 'published'));
    expect(published.status).toBe('published');
    expect(published.publishedAt).toBeInstanceOf(Date);
    const hidden = unwrap(await reviews.moderate(staff, waiting!.id, 'hidden'));
    expect(hidden).toMatchObject({ status: 'hidden', publishedAt: null });
    expect(errorsOf(await reviews.moderate(f.b, waiting!.id, 'published'))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);

    expect((await f.outbox()).map((event) => event.event_type)).toEqual([
      'product.created',
      ReviewEvents.Written,
      ReviewEvents.Published,
      ReviewEvents.Hidden,
    ]);
    // The other shop sees none of it.
    expect(await reviews.list(f.b)).toEqual([]);
  });

  it('publishes by itself a review of as many stars as the shop says, and one changed again', async () => {
    const lawn = await product('Lawn Suit');
    const chiffon = await product('Chiffon Dupatta');
    expect(unwrap(await reviews.updateSettings(staff, { publishFrom: 4 }))).toEqual({
      publishFrom: 4,
      requestAfterDays: null,
    });
    expect(errorsOf(await reviews.updateSettings(staff, { publishFrom: 2 }))).toEqual([
      ['publishFrom', 'INVALID'],
    ]);
    // Asking for reviews after delivery (ADR-400): 1 to 14 days, the stars left as they were.
    for (const days of [0, 15, 2.5]) {
      expect(errorsOf(await reviews.updateSettings(staff, { requestAfterDays: days }))).toEqual([
        ['requestAfterDays', 'INVALID'],
      ]);
    }
    expect(unwrap(await reviews.updateSettings(staff, { requestAfterDays: 3 }))).toEqual({
      publishFrom: 4,
      requestAfterDays: 3,
    });
    expect(await reviews.settings(staff)).toEqual({ publishFrom: 4, requestAfterDays: 3 });

    const orderId = newId();
    await write(orderId, [
      { productId: lawn, rating: 5, body: null },
      { productId: chiffon, rating: 3, body: 'Thinner than shown' },
      // Out of range, and of no product of the shop's: passed over.
      { productId: lawn, rating: 6, body: null },
      { productId: newId(), rating: 5, body: null },
    ]);
    const byProduct = async () =>
      Object.fromEntries(
        (await f.db.tenant(f.a.shopId, (tx) => reviewsOfOrderIn(tx, f.a.shopId, orderId))).map(
          (review) => [review.productId, review.status],
        ),
      );
    expect(await byProduct()).toEqual({ [lawn]: 'published', [chiffon]: 'pending' });

    // The same again changes nothing; fewer stars send it back to wait.
    expect(await write(orderId, [{ productId: lawn, rating: 5, body: null }])).toBe(0);
    expect(await write(orderId, [{ productId: lawn, rating: 2, body: 'Faded in the wash' }])).toBe(
      1,
    );
    expect(await byProduct()).toEqual({ [lawn]: 'pending', [chiffon]: 'pending' });

    // One product's, newest first, a page at a time.
    const all = await reviews.list(staff);
    expect(all.map((review) => review.productTitle)).toEqual(['Chiffon Dupatta', 'Lawn Suit']);
    expect(await reviews.list(staff, { productId: lawn })).toHaveLength(1);
    const [first] = await reviews.list(staff, { first: 1 });
    expect(await reviews.list(staff, { first: 1, after: first!.id })).toEqual([all[1]]);
  });

  it("shows a product's published reviews alone, their average and the latest first (ADR-401)", async () => {
    const lawn = await product('Lawn Suit');
    const chiffon = await product('Chiffon Dupatta');
    unwrap(await reviews.updateSettings(staff, { publishFrom: 3 }));
    for (const [rating, body] of [
      [5, 'Lovely'],
      [4, null],
      [2, 'Faded'],
      [3, 'Fine'],
    ] as const) {
      await write(newId(), [{ productId: lawn, rating, body }]);
    }
    const shown = () =>
      f.db.tenant(f.a.shopId, (tx) => shownReviewsIn(tx, f.a.shopId, [lawn, chiffon]));
    // The two-star review waits; the rest are published. The chiffon has none.
    const first = await shown();
    expect([...first.keys()]).toEqual([lawn]);
    expect(first.get(lawn)).toMatchObject({ rating: 4, count: 3 });
    expect(first.get(lawn)!.latest.map((review) => [review.rating, review.body])).toEqual([
      [3, 'Fine'],
      [4, null],
      [5, 'Lovely'],
    ]);
    expect(first.get(lawn)!.latest[0]).toMatchObject({
      author: 'Ayesha K.',
      publishedAt: expect.any(Date),
    });
    // Hidden, one goes; another shop sees none of them.
    const [fine] = await reviews.list(staff, { status: 'published', first: 1 });
    unwrap(await reviews.moderate(staff, fine!.id, 'hidden'));
    expect((await shown()).get(lawn)).toMatchObject({ rating: 4.5, count: 2 });
    expect(await f.db.tenant(f.b.shopId, (tx) => shownReviewsIn(tx, f.b.shopId, [lawn]))).toEqual(
      new Map(),
    );
  });

  it("goes with its customer's data: listed in their export, theirs on a merge, erased with them", async () => {
    const lawn = await product('Lawn Suit');
    await write(newId(), [{ productId: lawn, rating: 5, body: 'Lovely' }]);
    const into = newId();
    const mine = (id: string) =>
      f.db.tenant(f.a.shopId, (tx) => reviewsOfCustomerIn(tx, f.a.shopId, id));
    expect(await mine(customerId)).toEqual([
      { product: 'Lawn Suit', rating: 5, body: 'Lovely', at: expect.any(Date) },
    ]);
    await f.db.tenant(f.a.shopId, (tx) => mergeReviewsIn(tx, f.a.shopId, customerId, into));
    expect(await mine(customerId)).toEqual([]);
    expect(await mine(into)).toHaveLength(1);
    expect(await f.db.tenant(f.a.shopId, (tx) => eraseReviewsIn(tx, f.a.shopId, into))).toBe(1);
    expect(await reviews.list(staff)).toEqual([]);
  });
});
