import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPLEMENTARY_PRODUCTS,
  ComplementEvents,
  ComplementService,
  complementsIn,
} from './complements.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Complementary products (MKT-09, ADR-435)', () => {
  let f: CatalogFixture;
  let complements: ComplementService;

  const product = async (title: string, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'active' })).id;
  const events = async () =>
    (await f.outbox()).filter((event) => event.event_type === ComplementEvents.Updated);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    complements = new ComplementService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('pairs a product with others in the shop’s order, in place of those it had', async () => {
    const kurta = await product('Lawn kurta');
    const dupatta = await product('Chiffon dupatta');
    const trouser = await product('Cotton trouser');
    const khussa = await product('Khussa');

    expect(unwrap(await complements.set(f.a, kurta, [trouser, dupatta]))).toEqual([
      trouser,
      dupatta,
    ]);
    expect((await complements.of(f.a, [kurta, dupatta])).get(kurta)).toEqual([trouser, dupatta]);
    expect((await complements.of(f.a, [dupatta])).has(dupatta)).toBe(false);
    const records = (await complements.productsOf(f.a, [kurta])).get(kurta)!;
    expect(records.map((record) => record.title)).toEqual(['Cotton trouser', 'Chiffon dupatta']);
    expect(await events()).toEqual([expect.objectContaining({ aggregate_id: kurta, payload: {} })]);

    // The same again changes nothing; another order, another list.
    unwrap(await complements.set(f.a, kurta, [trouser, dupatta]));
    expect(await events()).toHaveLength(1);
    unwrap(await complements.set(f.a, kurta, [khussa, dupatta, trouser]));
    expect(await f.db.tenant(f.a.shopId, (tx) => complementsIn(tx, f.a.shopId, [kurta]))).toEqual(
      new Map([[kurta, [khussa, dupatta, trouser]]]),
    );
    // A product deleted leaves the lists it was in; none, and it pairs with none.
    unwrap(await f.products.delete(f.a, dupatta));
    expect((await complements.of(f.a, [kurta])).get(kurta)).toEqual([khussa, trouser]);
    expect(unwrap(await complements.set(f.a, kurta, []))).toEqual([]);
    expect((await complements.of(f.a, [kurta])).has(kurta)).toBe(false);
    expect(await events()).toHaveLength(3);
  });

  it('pairs with the shop’s own other products, each once, so many at most', async () => {
    const kurta = await product('Lawn kurta');
    const dupatta = await product('Chiffon dupatta');
    const theirs = await product('Their shawl', f.b);
    expect(errorsOf(await complements.set(f.a, kurta, [dupatta, kurta, dupatta]))).toEqual([
      ['complementIds.1', 'INVALID'],
      ['complementIds.2', 'TAKEN'],
    ]);
    expect(errorsOf(await complements.set(f.a, kurta, [dupatta, theirs, newId()]))).toEqual([
      ['complementIds.1', 'NOT_FOUND'],
      ['complementIds.2', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await complements.set(f.a, theirs, [dupatta]))).toEqual([
      ['productId', 'NOT_FOUND'],
    ]);
    const many: string[] = [];
    for (let index = 0; index <= COMPLEMENTARY_PRODUCTS; index++) {
      many.push(await product(`Dupatta ${index}`));
    }
    expect(errorsOf(await complements.set(f.a, kurta, many))).toEqual([
      ['complementIds', 'TOO_MANY'],
    ]);
    unwrap(await complements.set(f.a, kurta, many.slice(0, COMPLEMENTARY_PRODUCTS)));
    expect((await complements.of(f.a, [kurta])).get(kurta)).toHaveLength(COMPLEMENTARY_PRODUCTS);
    expect(await events()).toHaveLength(1);
  });
});
