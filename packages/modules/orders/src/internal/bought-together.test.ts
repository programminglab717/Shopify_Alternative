import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOUGHT_TOGETHER, boughtTogetherIn } from './bought-together.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Products bought together (ADR-480)', () => {
  let f: OrdersFixture;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  /** A product with one variant: its product's and its variant's IDs. */
  async function product(title: string) {
    const [variantId] = await f.variantsOf(f.a, title);
    const order = await f.order(f.a, [variantId!]);
    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'other' }));
    return { productId: order.lines[0]!.productId, variantId: variantId! };
  }

  const together = (shopId: string, ids: string[]) =>
    f.db.tenant(shopId, (tx) => boughtTogetherIn(tx, shopId, ids));

  it('gives the products in two orders or more with each, the most orders first', async () => {
    const kurta = await product('Kurta');
    const shalwar = await product('Shalwar');
    const khussa = await product('Khussa');
    const dupatta = await product('Dupatta');
    for (let i = 0; i < 3; i += 1) await f.order(f.a, [kurta.variantId, shalwar.variantId]);
    for (let i = 0; i < 2; i += 1) await f.order(f.a, [kurta.variantId, khussa.variantId]);
    // Once is not enough.
    await f.order(f.a, [kurta.variantId, dupatta.variantId]);
    // Cancelled orders don't count.
    for (let i = 0; i < 2; i += 1) {
      const order = await f.order(f.a, [shalwar.variantId, dupatta.variantId]);
      unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    }

    const found = await together(f.a.shopId, [
      kurta.productId,
      shalwar.productId,
      dupatta.productId,
    ]);
    expect(found.get(kurta.productId)).toEqual([shalwar.productId, khussa.productId]);
    expect(found.get(shalwar.productId)).toEqual([kurta.productId]);
    // Bought with none twice: left out.
    expect(found.has(dupatta.productId)).toBe(false);
    // Another shop sees none of them.
    expect((await together(f.b.shopId, [kurta.productId])).size).toBe(0);
    expect(await together(f.a.shopId, [])).toEqual(new Map());
  });

  it(`gives ${BOUGHT_TOGETHER} at most, those bought together latest first among equals`, async () => {
    const kurta = await product('Kurta');
    const others = [];
    for (let i = 0; i < BOUGHT_TOGETHER + 1; i += 1) others.push(await product(`Other ${i}`));
    for (const other of others) {
      for (let i = 0; i < 2; i += 1) await f.order(f.a, [kurta.variantId, other.variantId]);
    }
    const found = (await together(f.a.shopId, [kurta.productId])).get(kurta.productId)!;
    expect(found).toHaveLength(BOUGHT_TOGETHER);
    expect(found[0]).toBe(others.at(-1)!.productId);
    expect(found).not.toContain(others[0]!.productId);
  });
});
