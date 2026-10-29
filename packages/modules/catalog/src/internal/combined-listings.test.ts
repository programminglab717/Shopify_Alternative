import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CombinedListingEvents,
  CombinedListingService,
  combinedListingsIn,
} from './combined-listings.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Combined listings (CAT-23, ADR-799)', () => {
  let f: CatalogFixture;
  let listings: CombinedListingService;

  const product = async (title: string, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'active' })).id;
  const events = async () =>
    (await f.outbox()).filter((event) => event.event_type === CombinedListingEvents.Updated);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    listings = new CombinedListingService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('shows products as one listing, each a value of its option, and changes and deletes it', async () => {
    const maroon = await product('Lawn suit 12A, maroon');
    const teal = await product('Lawn suit 12A, teal');
    const mustard = await product('Lawn suit 12A, mustard');

    const made = unwrap(
      await listings.set(f.a, null, {
        optionName: ' Colour ',
        products: [
          { productId: maroon, value: 'Maroon ' },
          { productId: teal, value: 'Teal' },
        ],
      }),
    );
    expect(made).toMatchObject({
      optionName: 'Colour',
      products: [
        { productId: maroon, value: 'Maroon', active: true },
        { productId: teal, value: 'Teal', active: true },
      ],
    });
    const byProduct = await f.db.tenant(f.a.shopId, (tx) =>
      combinedListingsIn(tx, f.a.shopId, [teal, mustard]),
    );
    expect([...byProduct.keys()]).toEqual([teal]);
    expect(byProduct.get(teal)!.id).toBe(made.id);
    expect((await listings.productsOf(f.a, [maroon])).get(maroon)?.title).toBe(
      'Lawn suit 12A, maroon',
    );

    // Changed: another order, a product added and one taken away, each page told.
    const changed = unwrap(
      await listings.set(f.a, made.id, {
        optionName: 'Color',
        products: [
          { productId: mustard, value: 'Mustard' },
          { productId: teal, value: 'Teal' },
        ],
      }),
    );
    expect(changed.products.map((each) => each.value)).toEqual(['Mustard', 'Teal']);
    expect((await listings.ofProducts(f.a, [maroon])).has(maroon)).toBe(false);
    const [first, second] = await events();
    expect(first!.payload).toEqual({ productIds: [maroon, teal] });
    expect(new Set((second!.payload as { productIds: string[] }).productIds)).toEqual(
      new Set([maroon, teal, mustard]),
    );
    expect((await listings.list(f.a)).map((each) => each.id)).toEqual([made.id]);

    // A product deleted leaves it; deleted, its products stay on their own.
    unwrap(await f.products.delete(f.a, mustard));
    // A product taken off sale stays, said to be off sale.
    unwrap(await f.products.update(f.a, { id: teal, status: 'draft' }));
    expect((await listings.get(f.a, made.id))!.products).toEqual([
      { productId: teal, value: 'Teal', valueUr: null, active: false },
    ]);
    expect(unwrap(await listings.delete(f.a, made.id))).toBe(made.id);
    expect(await listings.get(f.a, made.id)).toBeNull();
    expect((await events()).at(-1)!.payload).toEqual({ productIds: [teal] });
    expect(errorsOf(await listings.delete(f.a, made.id))).toEqual([['id', 'NOT_FOUND']]);
  });

  it('shows a listing as one card in collections where the shop says, kept unless changed (ADR-901)', async () => {
    const maroon = await product('Maroon');
    const teal = await product('Teal');
    const products = [
      { productId: maroon, value: 'Maroon' },
      { productId: teal, value: 'Teal' },
    ];
    const made = unwrap(await listings.set(f.a, null, { optionName: 'Colour', products }));
    expect(made.oneCard).toBe(false);
    const carded = unwrap(
      await listings.set(f.a, made.id, { optionName: 'Colour', products, oneCard: true }),
    );
    expect(carded.oneCard).toBe(true);
    // Left out, as it was.
    const kept = unwrap(
      await listings.set(f.a, made.id, { optionName: 'Colour', products: [...products].reverse() }),
    );
    expect(kept.oneCard).toBe(true);
    expect(
      unwrap(await listings.set(f.a, made.id, { optionName: 'Colour', products, oneCard: false }))
        .oneCard,
    ).toBe(false);
  });

  it('keeps its option and values in Urdu, as they were where a change leaves them out (ADR-902)', async () => {
    const maroon = await product('Urdu maroon');
    const teal = await product('Urdu teal');
    const made = unwrap(
      await listings.set(f.a, null, {
        optionName: 'Colour',
        optionNameUr: ' رنگ ',
        products: [
          { productId: maroon, value: 'Maroon', valueUr: 'مرون' },
          { productId: teal, value: 'Teal', valueUr: ' ' },
        ],
      }),
    );
    expect(made.optionNameUr).toBe('رنگ');
    expect(made.products.map((each) => each.valueUr)).toEqual(['مرون', null]);
    // Left out: kept, for each product whatever its place; null clears.
    const kept = unwrap(
      await listings.set(f.a, made.id, {
        optionName: 'Colour',
        products: [
          { productId: teal, value: 'Teal', valueUr: 'فیروزی' },
          { productId: maroon, value: 'Maroon' },
        ],
      }),
    );
    expect(kept.optionNameUr).toBe('رنگ');
    expect(kept.products.map((each) => each.valueUr)).toEqual(['فیروزی', 'مرون']);
    const cleared = unwrap(
      await listings.set(f.a, made.id, {
        optionName: 'Colour',
        optionNameUr: null,
        products: [
          { productId: teal, value: 'Teal', valueUr: null },
          { productId: maroon, value: 'Maroon' },
        ],
      }),
    );
    expect(cleared.optionNameUr).toBeNull();
    expect(cleared.products.map((each) => each.valueUr)).toEqual([null, 'مرون']);
    expect(
      errorsOf(
        await listings.set(f.a, made.id, {
          optionName: 'Colour',
          optionNameUr: 'ر'.repeat(256),
          products: [
            { productId: teal, value: 'Teal', valueUr: 'ف'.repeat(256) },
            { productId: maroon, value: 'Maroon' },
          ],
        }),
      ),
    ).toEqual([
      ['input.optionNameUr', 'TOO_LONG'],
      ['input.products.0.valueUr', 'TOO_LONG'],
    ]);
  });

  it("refuses too few products, one named twice, a value twice, another listing's, and another shop's", async () => {
    const maroon = await product('Maroon');
    const teal = await product('Teal');
    const black = await product('Black');
    const theirs = await product('Theirs', f.b);
    const set = (products: { productId: string; value: string }[], optionName = 'Colour') =>
      listings.set(f.a, null, { optionName, products });

    expect(errorsOf(await set([{ productId: maroon, value: 'Maroon' }], ' '))).toEqual([
      ['input.optionName', 'INVALID'],
      ['input.products', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await set([
          { productId: maroon, value: 'Maroon' },
          { productId: maroon, value: 'maroon' },
          { productId: teal, value: '' },
        ]),
      ),
    ).toEqual([
      ['input.products.1.productId', 'TAKEN'],
      ['input.products.1.value', 'TAKEN'],
      ['input.products.2.value', 'INVALID'],
    ]);
    unwrap(
      await set([
        { productId: maroon, value: 'Maroon' },
        { productId: teal, value: 'Teal' },
      ]),
    );
    expect(
      errorsOf(
        await set([
          { productId: black, value: 'Black' },
          { productId: teal, value: 'Teal' },
          { productId: theirs, value: 'Theirs' },
        ]),
      ),
    ).toEqual([
      ['input.products.1.productId', 'TAKEN'],
      ['input.products.2.productId', 'NOT_FOUND'],
    ]);
    expect(
      errorsOf(
        await listings.set(f.a, '00000000-0000-0000-0000-000000000000', {
          optionName: 'Colour',
          products: [
            { productId: black, value: 'Black' },
            { productId: teal, value: 'Teal' },
          ],
        }),
      ),
    ).toEqual([['id', 'NOT_FOUND']]);
    // Another shop sees none of it.
    expect(await listings.list(f.b)).toEqual([]);
  });
});
