import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_LIMITS,
  BundleEvents,
  BundleService,
  bundleProductIdsIn,
  bundlesOfVariantsIn,
} from './bundles.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Bundles and multipacks (CAT-11, ADR-409)', () => {
  let f: CatalogFixture;
  let bundles: BundleService;

  /** A product of one variant: its ID and its variant's. */
  const single = async (title: string, tenant = f.a): Promise<[string, string]> => {
    const product = unwrap(await f.products.create(tenant, { title, status: 'active' }));
    return [product.id, product.variants[0]!.id];
  };
  const events = async () =>
    (await f.outbox()).filter((event) => event.event_type === BundleEvents.Updated);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    bundles = new BundleService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('makes a product a bundle of other variants, a number of each, and no bundle again', async () => {
    const [set, setVariant] = await single('Eid 3-piece set');
    const [, shirt] = await single('Lawn shirt');
    const [, dupatta] = await single('Chiffon dupatta');
    const [, trouser] = await single('Cotton trouser');

    const made = unwrap(
      await bundles.set(f.a, set, [
        { variantId: shirt, quantity: 1 },
        { variantId: dupatta, quantity: 1 },
        { variantId: trouser, quantity: 2 },
      ]),
    );
    expect(made).toMatchObject({
      productId: set,
      variantId: setVariant,
      complete: true,
      components: [
        {
          variantId: shirt,
          productTitle: 'Lawn shirt',
          variantTitle: 'Default Title',
          quantity: 1,
        },
        { variantId: dupatta, quantity: 1 },
        { variantId: trouser, quantity: 2 },
      ],
    });
    // Sold through its own variant; the same again changes nothing.
    const sold = await f.db.tenant(f.a.shopId, (tx) =>
      bundlesOfVariantsIn(tx, f.a.shopId, [setVariant, shirt]),
    );
    expect([...sold.keys()]).toEqual([setVariant]);
    unwrap(
      await bundles.set(f.a, set, [
        { variantId: shirt, quantity: 1 },
        { variantId: dupatta, quantity: 1 },
        { variantId: trouser, quantity: 2 },
      ]),
    );
    expect(await events()).toHaveLength(1);

    // A multipack: three of one.
    const [pack] = await single('Socks, 3-pack');
    const [, sock] = await single('Socks');
    expect(unwrap(await bundles.set(f.a, pack, [{ variantId: sock, quantity: 3 }]))).toMatchObject({
      components: [{ variantId: sock, quantity: 3 }],
    });
    expect(await f.db.tenant(f.a.shopId, (tx) => bundleProductIdsIn(tx, f.a.shopId))).toEqual(
      [set, pack].sort(),
    );

    expect(unwrap(await bundles.set(f.a, set, []))).toBeNull();
    expect((await bundles.of(f.a, [set, pack])).has(set)).toBe(false);
    expect((await events()).map((event) => event.payload)).toEqual([
      { variantIds: [shirt, dupatta, trouser].sort() },
      { variantIds: [sock] },
      { variantIds: [shirt, dupatta, trouser].sort() },
    ]);
  });

  it('refuses parts that do not make a bundle', async () => {
    const [set] = await single('Eid set');
    const [, shirt] = await single('Lawn shirt');
    const [, theirs] = await single('Their shirt', f.b);
    expect(errorsOf(await bundles.set(f.a, set, [{ variantId: shirt, quantity: 1 }]))).toEqual([
      ['components', 'TOO_FEW'],
    ]);
    expect(
      errorsOf(
        await bundles.set(f.a, set, [
          { variantId: shirt, quantity: 0 },
          { variantId: shirt, quantity: 100 },
        ]),
      ),
    ).toEqual([
      ['components.0.quantity', 'INVALID'],
      ['components.1.quantity', 'INVALID'],
      ['components.1.variantId', 'TAKEN'],
    ]);
    expect(
      errorsOf(
        await bundles.set(
          f.a,
          set,
          Array.from({ length: BUNDLE_LIMITS.parts + 1 }, () => ({
            variantId: newId(),
            quantity: 1,
          })),
        ),
      ),
    ).toContainEqual(['components', 'TOO_MANY']);
    const [, own] = [set, (await f.products.get(f.a, set))!.variants[0]!.id];
    expect(
      errorsOf(
        await bundles.set(f.a, set, [
          { variantId: theirs, quantity: 1 },
          { variantId: own, quantity: 1 },
        ]),
      ),
    ).toEqual([
      ['components.0.variantId', 'NOT_FOUND'],
      ['components.1.variantId', 'INVALID'],
    ]);
    expect(errorsOf(await bundles.set(f.a, newId(), [{ variantId: shirt, quantity: 2 }]))).toEqual([
      ['productId', 'NOT_FOUND'],
    ]);
  });

  it('keeps bundles one variant deep: none of options, none within another', async () => {
    const [set, setVariant] = await single('Eid set');
    const [shirtProduct, shirt] = await single('Lawn shirt');
    unwrap(await bundles.set(f.a, set, [{ variantId: shirt, quantity: 2 }]));

    // A bundle takes no options or variants of its own.
    expect(
      errorsOf(await f.options.create(f.a, set, [{ name: 'Size', values: ['S', 'M'] }])),
    ).toEqual([['productId', 'INVALID']]);
    // No bundle holds a bundle, and no part becomes one.
    const [gift] = await single('Gift box');
    expect(
      errorsOf(await bundles.set(f.a, gift, [{ variantId: setVariant, quantity: 2 }])),
    ).toEqual([['components.0.variantId', 'INVALID']]);
    const [, dupatta] = await single('Dupatta');
    expect(
      errorsOf(await bundles.set(f.a, shirtProduct, [{ variantId: dupatta, quantity: 2 }])),
    ).toEqual([['productId', 'INVALID']]);
    // A product of options is no bundle.
    const sized = unwrap(
      await f.products.create(f.a, {
        title: 'Kurta',
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [
          { optionValues: ['S'], price: '1000' },
          { optionValues: ['M'], price: '1000' },
        ],
      }),
    );
    expect(errorsOf(await bundles.set(f.a, sized.id, [{ variantId: shirt, quantity: 2 }]))).toEqual(
      [['productId', 'INVALID']],
    );
  });

  it('is not sold whole once a part is deleted, and goes with its product', async () => {
    const [set, setVariant] = await single('Eid set');
    const [shirtProduct, shirt] = await single('Lawn shirt');
    const [, dupatta] = await single('Dupatta');
    unwrap(
      await bundles.set(f.a, set, [
        { variantId: shirt, quantity: 1 },
        { variantId: dupatta, quantity: 1 },
      ]),
    );
    unwrap(await f.products.delete(f.a, shirtProduct));
    const broken = (await bundles.of(f.a, [set])).get(set)!;
    expect([broken.complete, broken.components.map((part) => part.variantId)]).toEqual([
      false,
      [dupatta],
    ]);
    // Given its parts again, it is whole.
    const [, other] = await single('Silk shirt');
    expect(
      unwrap(
        await bundles.set(f.a, set, [
          { variantId: other, quantity: 1 },
          { variantId: dupatta, quantity: 1 },
        ]),
      )?.complete,
    ).toBe(true);
    unwrap(await f.products.delete(f.a, set));
    expect(
      await f.db.tenant(f.a.shopId, (tx) => bundlesOfVariantsIn(tx, f.a.shopId, [setVariant])),
    ).toEqual(new Map());
    expect(await bundles.of(f.b, [set])).toEqual(new Map());
  });
});
