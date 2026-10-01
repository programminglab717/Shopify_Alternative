import 'reflect-metadata';
import type { Tx } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionCursor } from './collection.service.js';
import type { ProductRecord } from './records.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('CollectionService', () => {
  let f: CatalogFixture;
  const product = async (title: string, extra: Record<string, unknown> = {}) =>
    unwrap(await f.products.create(f.a, { title, ...extra }));
  /** Every product id in the collection, walking pages of `size`. */
  const members = async (collectionId: string, size = 50): Promise<string[]> => {
    const ids: string[] = [];
    let after: CollectionCursor | null = null;
    for (;;) {
      const page = await f.collections.products(f.a, collectionId, { first: size, after });
      if (!page) throw new Error('Collection not found');
      ids.push(...page.items.map((item) => item.id));
      if (!page.hasNextPage) return ids;
      after = page.cursors.at(-1)!;
    }
  };
  const idsOf = (...products: ProductRecord[]) => products.map((p) => p.id);

  beforeAll(async () => {
    f = await catalogFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  describe('manual collections', () => {
    it('keeps the products merchants add, in their order', async () => {
      const [lawn, khussa, ajrak] = [
        await product('Lawn Suit'),
        await product('Khussa'),
        await product('Ajrak'),
      ];
      const collection = unwrap(
        await f.collections.create(f.a, { title: 'Eid Edit', productIds: idsOf(khussa, lawn) }),
      );
      expect(collection).toMatchObject({
        title: 'Eid Edit',
        handle: 'eid-edit',
        sortOrder: 'manual',
        rules: null,
        productsCount: 2,
        version: 1,
      });
      expect(await members(collection.id)).toEqual(idsOf(khussa, lawn));

      const added = unwrap(
        await f.collections.addProducts(f.a, collection.id, idsOf(ajrak, khussa)),
      );
      expect(added).toMatchObject({ productsCount: 3, version: 2 });
      expect(await members(collection.id)).toEqual(idsOf(khussa, lawn, ajrak));

      unwrap(
        await f.collections.reorderProducts(f.a, collection.id, [{ id: ajrak.id, newPosition: 1 }]),
      );
      expect(await members(collection.id)).toEqual(idsOf(ajrak, khussa, lawn));

      unwrap(await f.collections.removeProducts(f.a, collection.id, [khussa.id]));
      expect(await members(collection.id)).toEqual(idsOf(ajrak, lawn));
      expect(
        (await f.outbox()).filter((event) => event.event_type.startsWith('collection')),
      ).toMatchObject([
        { event_type: 'collection.created', payload: { handle: 'eid-edit', smart: false } },
        { event_type: 'collection.updated', payload: { changed: ['products'], version: 2 } },
        { event_type: 'collection.updated', payload: { changed: ['products'], version: 3 } },
        { event_type: 'collection.updated', payload: { changed: ['products'], version: 4 } },
      ]);
    });

    it('reports products that do not exist', async () => {
      const lawn = await product('Lawn Suit');
      const other = unwrap(await f.products.create(f.b, { title: "Shop B's" }));
      expect(
        errorsOf(
          await f.collections.create(f.a, { title: 'Mixed', productIds: [lawn.id, other.id] }),
        ),
      ).toEqual([['input.productIds.1', 'NOT_FOUND']]);
      const collection = unwrap(await f.collections.create(f.a, { title: 'Empty' }));
      expect(errorsOf(await f.collections.addProducts(f.a, collection.id, [other.id]))).toEqual([
        ['productIds.0', 'NOT_FOUND'],
      ]);
    });
  });

  describe('smart collections', () => {
    it('hold exactly the products that meet their rules, as products change', async () => {
      const eidLawn = await product('Embroidered Lawn Suit', {
        tags: ['Eid'],
        variants: [{ price: '6,500' }],
      });
      await product('Printed Lawn Suit', { tags: ['summer'], variants: [{ price: '3,200' }] });
      const eidKhussa = await product('Gold Khussa', {
        tags: ['eid'],
        variants: [{ price: '2,250' }],
      });
      const collection = unwrap(
        await f.collections.create(f.a, {
          title: 'Eid under 5,000',
          ruleSet: {
            appliedDisjunctively: false,
            rules: [
              { column: 'tag', relation: 'equals', condition: 'EID' },
              { column: 'variant_price', relation: 'less_than', condition: '5000' },
            ],
          },
        }),
      );
      expect(collection).toMatchObject({
        sortOrder: 'created_desc',
        productsCount: 1,
        rules: [
          { column: 'tag', relation: 'equals', condition: 'EID' },
          { column: 'variant_price', relation: 'less_than', condition: '5000' },
        ],
      });
      expect(await members(collection.id)).toEqual([eidKhussa.id]);

      // A price cut brings the lawn suit in; losing its tag takes the khussa out.
      unwrap(
        await f.variants.bulkUpdate(f.a, eidLawn.id, [
          { id: eidLawn.variants[0]!.id, price: '4,999' },
        ]),
      );
      unwrap(await f.products.update(f.a, { id: eidKhussa.id, tags: ['wedding'] }));
      expect(await members(collection.id)).toEqual([eidLawn.id]);

      // New products join as they are created.
      const fresh = await product('Eid Ajrak', { tags: ['eid'], variants: [{ price: '1850' }] });
      expect(await members(collection.id)).toEqual(idsOf(fresh, eidLawn));
      expect((await f.collections.get(f.a, collection.id))?.productsCount).toBe(2);
    });

    it('match any rule when disjunctive, and re-check every product when rules change', async () => {
      const chappal = await product('Peshawari Chappal', { productType: 'Footwear' });
      const khussa = await product('Multani Khussa', { vendor: 'Multan Crafts' });
      await product('Lawn Suit');
      const collection = unwrap(
        await f.collections.create(f.a, {
          title: 'Shoes',
          ruleSet: {
            appliedDisjunctively: true,
            rules: [
              { column: 'type', relation: 'equals', condition: 'footwear' },
              { column: 'title', relation: 'contains', condition: 'khussa' },
            ],
          },
          sortOrder: 'alpha_asc',
        }),
      );
      expect(await members(collection.id)).toEqual(idsOf(khussa, chappal));
      const updated = unwrap(
        await f.collections.update(f.a, {
          id: collection.id,
          ruleSet: {
            appliedDisjunctively: false,
            rules: [{ column: 'vendor', relation: 'starts_with', condition: 'Multan' }],
          },
        }),
      );
      expect(updated).toMatchObject({ disjunctive: false, productsCount: 1, version: 2 });
      expect(await members(collection.id)).toEqual([khussa.id]);
      expect((await f.outbox()).at(-1)).toMatchObject({
        event_type: 'collection.updated',
        payload: { changed: ['rules'], version: 2 },
      });
      unwrap(
        await f.collections.update(f.a, {
          id: collection.id,
          handle: 'multani',
          redirectNewHandle: true,
        }),
      );
      expect((await f.outbox()).at(-1)?.payload).toEqual({
        changed: ['handle'],
        version: 3,
        previousHandle: collection.handle,
        redirectNewHandle: true,
      });
      expect(
        await f.db.tenant(f.a.shopId, (tx) =>
          f.collections.handleOf(tx, f.a.shopId, collection.id),
        ),
      ).toBe('multani');
    });

    it('understand variant titles, compare-at prices and price reductions', async () => {
      const sale = await product('Kurta on sale', {
        options: [{ name: 'Size', values: ['S', 'XL'] }],
        variants: [
          { optionValues: ['S'], price: '2000', compareAtPrice: '2500' },
          { optionValues: ['XL'], price: '2200' },
        ],
      });
      await product('Kurta', { variants: [{ price: '2000' }] });
      const create = async (rule: { column: string; relation: string; condition?: string }) =>
        unwrap(
          await f.collections.create(f.a, {
            title: `${rule.column} ${rule.relation}`,
            ruleSet: {
              appliedDisjunctively: false,
              rules: [{ condition: '', ...rule } as never],
            },
          }),
        );
      for (const rule of [
        { column: 'is_price_reduced', relation: 'is_set' },
        { column: 'variant_compare_at_price', relation: 'is_set' },
        { column: 'variant_title', relation: 'equals', condition: 'xl' },
        { column: 'variant_compare_at_price', relation: 'greater_than', condition: '2,400' },
      ]) {
        expect(await members((await create(rule)).id), rule.column).toEqual([sale.id]);
      }
    });

    it('explain rules they cannot use', async () => {
      expect(
        errorsOf(
          await f.collections.create(f.a, {
            title: 'Broken',
            ruleSet: {
              appliedDisjunctively: false,
              rules: [
                { column: 'tag', relation: 'greater_than', condition: 'x' },
                { column: 'variant_price', relation: 'less_than', condition: 'cheap' },
                { column: 'title', relation: 'contains', condition: ' ' },
              ],
            },
          }),
        ),
      ).toEqual([
        ['input.ruleSet.rules.0.relation', 'INVALID'],
        ['input.ruleSet.rules.1.condition', 'INVALID'],
        ['input.ruleSet.rules.2.condition', 'INVALID'],
      ]);
      expect(
        errorsOf(
          await f.collections.create(f.a, {
            title: 'No rules',
            ruleSet: { appliedDisjunctively: false, rules: [] },
          }),
        ),
      ).toEqual([['input.ruleSet.rules', 'BLANK']]);
    });

    it('refuse manual changes, and stay smart', async () => {
      const lawn = await product('Lawn Suit');
      const smart = unwrap(
        await f.collections.create(f.a, {
          title: 'Lawn',
          ruleSet: {
            appliedDisjunctively: false,
            rules: [{ column: 'title', relation: 'contains', condition: 'lawn' }],
          },
        }),
      );
      expect(errorsOf(await f.collections.addProducts(f.a, smart.id, [lawn.id]))).toEqual([
        ['id', 'INVALID'],
      ]);
      expect(errorsOf(await f.collections.update(f.a, { id: smart.id, ruleSet: null }))).toEqual([
        ['input.ruleSet', 'BLANK'],
      ]);
      expect(
        errorsOf(await f.collections.update(f.a, { id: smart.id, sortOrder: 'manual' })),
      ).toEqual([['input.sortOrder', 'INVALID']]);
      const manual = unwrap(await f.collections.create(f.a, { title: 'Picks' }));
      expect(
        errorsOf(
          await f.collections.update(f.a, {
            id: manual.id,
            ruleSet: {
              appliedDisjunctively: false,
              rules: [{ column: 'title', relation: 'contains', condition: 'x' }],
            },
          }),
        ),
      ).toEqual([['input.ruleSet', 'INVALID']]);
    });
  });

  describe('sorting and pages', () => {
    it('pages through every sort order without gaps or repeats', async () => {
      const created = [];
      for (const [title, price] of [
        ['Dupatta', '1,450'],
        ['Ajrak', '1,850'],
        ['Chappal', '3,499'],
        ['Bedsheet', '2,999'],
        ['Kurta', '2,200'],
      ] as const) {
        created.push(await product(title, { tags: ['all'], variants: [{ price }] }));
      }
      const [dupatta, ajrak, chappal, bedsheet, kurta] = created as [
        ProductRecord,
        ProductRecord,
        ProductRecord,
        ProductRecord,
        ProductRecord,
      ];
      const collection = unwrap(
        await f.collections.create(f.a, {
          title: 'All',
          ruleSet: {
            appliedDisjunctively: false,
            rules: [{ column: 'tag', relation: 'equals', condition: 'all' }],
          },
        }),
      );
      const expectations = {
        alpha_asc: [ajrak, bedsheet, chappal, dupatta, kurta],
        alpha_desc: [kurta, dupatta, chappal, bedsheet, ajrak],
        price_asc: [dupatta, ajrak, kurta, bedsheet, chappal],
        price_desc: [chappal, bedsheet, kurta, ajrak, dupatta],
        created: [dupatta, ajrak, chappal, bedsheet, kurta],
        created_desc: [kurta, bedsheet, chappal, ajrak, dupatta],
      } as const;
      for (const [sortOrder, expected] of Object.entries(expectations)) {
        unwrap(
          await f.collections.update(f.a, {
            id: collection.id,
            sortOrder: sortOrder as keyof typeof expectations,
          }),
        );
        expect(await members(collection.id, 2), sortOrder).toEqual(idsOf(...expected));
      }
    });

    it('lists collections newest first, finds them by handle and by product', async () => {
      const lawn = await product('Lawn Suit');
      const eid = unwrap(await f.collections.create(f.a, { title: 'Eid', productIds: [lawn.id] }));
      const summer = unwrap(
        await f.collections.create(f.a, { title: 'Summer Lawn', productIds: [lawn.id] }),
      );
      await f.collections.create(f.a, { title: 'Winter' });
      const page = await f.collections.list(f.a, { first: 2 });
      expect(page.items.map((c) => c.title)).toEqual(['Winter', 'Summer Lawn']);
      expect(page.hasNextPage).toBe(true);
      expect(
        (await f.collections.list(f.a, { first: 5, query: 'lawn' })).items.map((c) => c.id),
      ).toEqual([summer.id]);
      expect((await f.collections.getByHandle(f.a, 'eid'))?.id).toBe(eid.id);
      // Each product's, a page of products at once.
      const khussa = await product('Khussa');
      const of = await f.collections.collectionsOfProducts(f.a, [lawn.id, khussa.id], {
        first: 1,
      });
      expect(of.get(lawn.id)).toEqual({
        items: [expect.objectContaining({ id: eid.id, productsCount: 1 })],
        hasNextPage: true,
      });
      expect(of.get(khussa.id)).toEqual({ items: [], hasNextPage: false });
      const next = await f.collections.collectionsOfProducts(f.a, [lawn.id], {
        first: 1,
        after: eid.id,
      });
      expect(next.get(lawn.id)).toEqual({
        items: [expect.objectContaining({ id: summer.id })],
        hasNextPage: false,
      });
      // Another shop's products are in none of this shop's collections.
      expect(
        (await f.collections.collectionsOfProducts(f.b, [lawn.id], { first: 10 })).get(lawn.id),
      ).toEqual({ items: [], hasNextPage: false });
    });
  });

  it('gives read models collections by ID, kind or product, and their active products', async () => {
    const lawn = await product('Lawn Suit', { status: 'active', tags: ['eid'] });
    const khussa = await product('Khussa', { tags: ['eid'] });
    const ajrak = await product('Ajrak', { status: 'active', variants: [{ price: '1,850' }] });
    const eid = unwrap(
      await f.collections.create(f.a, {
        title: 'Eid Edit',
        productIds: idsOf(khussa, lawn, ajrak),
      }),
    );
    const tagged = unwrap(
      await f.collections.create(f.a, {
        title: 'Tagged eid',
        sortOrder: 'alpha_desc',
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'tag', relation: 'equals', condition: 'eid' }],
        },
      }),
    );
    const read = <T>(work: (tx: Tx) => Promise<T>) => f.db.tenant(f.a.shopId, work);
    const titles = (records: { title: string }[]) => records.map((record) => record.title);

    expect(titles(await read((tx) => f.collections.recordsOf(tx, f.a.shopId)))).toEqual([
      'Eid Edit',
      'Tagged eid',
    ]);
    expect(
      titles(await read((tx) => f.collections.recordsOf(tx, f.a.shopId, { smart: true }))),
    ).toEqual(['Tagged eid']);
    expect(
      titles(
        await read((tx) => f.collections.recordsOf(tx, f.a.shopId, { containing: [ajrak.id] })),
      ),
    ).toEqual(['Eid Edit']);
    expect(
      titles(await read((tx) => f.collections.recordsOf(tx, f.a.shopId, { ids: [tagged.id] }))),
    ).toEqual(['Tagged eid']);
    // Drafts are left out; the order is the collection's own.
    expect(await read((tx) => f.collections.activeProductIdsOf(tx, f.a.shopId, eid))).toEqual(
      idsOf(lawn, ajrak),
    );
    expect(await read((tx) => f.collections.activeProductIdsOf(tx, f.a.shopId, tagged))).toEqual(
      idsOf(lawn),
    );

    const records = await read((tx) =>
      f.products.recordsOf(tx, f.a.shopId, [khussa.id, ajrak.id, newId()]),
    );
    expect(records.map((record) => record.id).sort()).toEqual(idsOf(khussa, ajrak).sort());
    expect(records.find((record) => record.id === ajrak.id)?.variants[0]?.price).toBe(185_000n);
    expect(await read((tx) => f.products.idsOf(tx, f.a.shopId))).toEqual(
      idsOf(ajrak, khussa, lawn),
    );
    expect(await read((tx) => f.products.idsOf(tx, f.a.shopId, { status: 'active' }))).toEqual(
      idsOf(ajrak, lawn),
    );
    // Another shop's transaction finds none of them.
    expect(
      await f.db.tenant(f.b.shopId, (tx) => f.products.recordsOf(tx, f.b.shopId, [ajrak.id])),
    ).toEqual([]);
  });

  it('deletes a collection and keeps its products', async () => {
    const lawn = await product('Lawn Suit');
    const collection = unwrap(
      await f.collections.create(f.a, { title: 'Eid', productIds: [lawn.id] }),
    );
    expect(unwrap(await f.collections.delete(f.a, collection.id))).toEqual({ id: collection.id });
    expect(await f.collections.get(f.a, collection.id)).toBeNull();
    expect(await f.products.get(f.a, lawn.id)).not.toBeNull();
    expect((await f.outbox()).at(-1)).toMatchObject({
      event_type: 'collection.deleted',
      payload: { handle: 'eid' },
    });
  });

  it("never shows or changes another shop's collections, or mixes in its products", async () => {
    await f.products.create(f.b, { title: 'Lawn from B', tags: ['eid'] });
    const smart = unwrap(
      await f.collections.create(f.a, {
        title: 'Eid',
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'tag', relation: 'equals', condition: 'eid' }],
        },
      }),
    );
    expect(smart.productsCount).toBe(0);
    expect(await f.collections.get(f.b, smart.id)).toBeNull();
    expect(await f.collections.products(f.b, smart.id, { first: 5 })).toBeNull();
    expect((await f.collections.list(f.b, { first: 5 })).items).toEqual([]);
    expect(errorsOf(await f.collections.update(f.b, { id: smart.id, title: 'Stolen' }))).toEqual([
      ['input.id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.collections.delete(f.b, smart.id))).toEqual([
      ['input.id', 'NOT_FOUND'],
    ]);
    // B's own smart collection sees only B's product.
    const bSmart = unwrap(
      await f.collections.create(f.b, {
        title: 'Eid',
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'tag', relation: 'equals', condition: 'eid' }],
        },
      }),
    );
    expect(bSmart.productsCount).toBe(1);
  });
});
