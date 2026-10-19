import 'reflect-metadata';
import { BundleService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountOrdersIn } from './account-orders.js';
import { ADDRESS, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)(
  "What a customer's orders sold, for their account to buy again (ADR-574)",
  () => {
    let f: OrdersFixture;
    let kurta: string;
    let suit: string;
    let shirt: string;
    let trouser: string;

    beforeAll(async () => {
      f = await ordersFixture(server!);
    });

    afterAll(async () => {
      await f?.close();
    });

    beforeEach(async () => {
      await f.reset();
      [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
      [suit] = (await f.variantsOf(f.a, 'Eid 3-piece suit', { price: '6,000' })) as [string];
      [shirt] = (await f.variantsOf(f.a, 'Lawn shirt', { price: '4,000' })) as [string];
      [trouser] = (await f.variantsOf(f.a, 'Cotton trouser', { price: '1,000' })) as [string];
      for (const variant of [kurta, shirt, trouser]) await f.stock(f.a, variant, 20);
      unwrap(
        await new BundleService(f.db).set(f.a, (await productOf(suit))!, [
          { variantId: shirt, quantity: 1 },
          { variantId: trouser, quantity: 2 },
        ]),
      );
    });

    const productOf = async (variantId: string) =>
      (
        await f.admin.query<{ product_id: string }>(
          'SELECT product_id FROM catalog.variants WHERE id = $1',
          [variantId],
        )
      ).rows[0]?.product_id;

    const read = (customerId: string, limit = { orders: 20, lines: 100 }) =>
      f.db.tenant(f.a.shopId, (tx) => accountOrdersIn(tx, f.a.shopId, customerId, limit));

    it('gives each order its lines as sold, and a bundle once, as its parts came to', async () => {
      const placed = unwrap(
        await f.orders.create(f.a, {
          lineItems: [
            { variantId: kurta, quantity: 2 },
            { variantId: suit, quantity: 2 },
          ],
          shippingAddress: ADDRESS,
        }),
      );
      const later = await f.order(f.a, [trouser]);
      // Another customer's is not theirs.
      await f.order(f.a, [kurta], { shippingAddress: { ...ADDRESS, phone: '0321-7654321' } });

      const orders = await read(placed.customerId!);
      expect(orders.map((order) => order.id)).toEqual([later.id, placed.id]);
      expect(orders[1]!.items).toEqual([
        {
          kind: 'line',
          variantId: kurta,
          productId: await productOf(kurta),
          title: 'Kurta',
          variantTitle: 'Default Title',
          quantity: 2,
        },
        {
          kind: 'bundle',
          title: 'Eid 3-piece suit',
          quantity: 2,
          parts: [
            { variantId: shirt, productId: await productOf(shirt), units: 2 },
            { variantId: trouser, productId: await productOf(trouser), units: 4 },
          ],
        },
      ]);
      expect(orders[0]!.items).toEqual([
        expect.objectContaining({ kind: 'line', variantId: trouser, quantity: 1 }),
      ]);

      // As many orders, and lines of each, as asked: a bundle cut short has the parts read.
      const fewer = await read(placed.customerId!, { orders: 1, lines: 2 });
      expect(fewer.map((order) => order.id)).toEqual([later.id]);
      const cut = await read(placed.customerId!, { orders: 2, lines: 2 });
      expect(cut[1]!.items).toEqual([
        expect.objectContaining({ kind: 'line', variantId: kurta }),
        expect.objectContaining({
          kind: 'bundle',
          parts: [expect.objectContaining({ variantId: shirt, units: 2 })],
        }),
      ]);
    });

    it('keeps what was sold, whatever the catalog has since', async () => {
      const placed = await f.order(f.a, [kurta]);
      await f.admin.query('DELETE FROM catalog.products WHERE id = $1', [await productOf(kurta)]);
      const [order] = await read(placed.customerId!);
      expect(order!.items).toEqual([
        expect.objectContaining({ kind: 'line', variantId: kurta, title: 'Kurta', quantity: 1 }),
      ]);
      // None for a customer without orders.
      expect(await read(f.a.shopId)).toEqual([]);
    });
  },
);
