import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SUPPORT_FACTS_ORDERS, supportFactsIn } from './support-facts.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)(
  "A customer's orders, as the AI answering them reads them (ADR-849)",
  () => {
    let f: OrdersFixture;
    let kurta: string;

    beforeAll(async () => {
      f = await ordersFixture(server!);
    });

    afterAll(async () => {
      await f?.close();
    });

    beforeEach(async () => {
      await f.reset();
      [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
      await f.stock(f.a, kurta, 20);
    });

    const factsOf = (phone: string, named?: number[]) =>
      f.db.tenant(f.a.shopId, (tx) => supportFactsIn(tx, f.a.shopId, phone, named));

    it("gives their latest orders' standing, payment and parcels, nothing of their address", async () => {
      const order = await f.order(f.a, [kurta]);
      unwrap(await f.orders.confirm(f.a, order.id));
      const { rows } = await f.admin.query<{ phone: string }>(
        'SELECT phone FROM orders.orders WHERE id = $1',
        [order.id],
      );
      const phone = rows[0]!.phone;
      const [line] = await factsOf(phone);
      expect(line).toMatch(
        new RegExp(
          `^Order #${order.number}, placed \\d{1,2} \\w{3} \\d{4}: confirmed, being packed; Rs [\\d,]+, cash on delivery, Rs [\\d,]+ still to pay$`,
        ),
      );
      expect(line).not.toContain('Street');
      // Named by number in the web chat: that order alone, and only from its own number.
      expect(await factsOf(phone, [order.number])).toHaveLength(1);
      expect(await factsOf(phone, [order.number + 1])).toEqual([]);
      expect(await factsOf('+923339998877', [order.number])).toEqual([]);
      expect(await factsOf(phone, [])).toEqual([]);
      // The latest few at most.
      for (let i = 0; i < SUPPORT_FACTS_ORDERS; i += 1) await f.order(f.a, [kurta]);
      expect(await factsOf(phone)).toHaveLength(SUPPORT_FACTS_ORDERS);
    });
  },
);
