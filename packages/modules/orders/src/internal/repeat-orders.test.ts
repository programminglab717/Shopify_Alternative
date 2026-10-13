import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADDRESS, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Orders that repeat another (CHK-11, ADR-392)', () => {
  let f: OrdersFixture;
  let kurta: string;
  let dupatta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [dupatta] = (await f.variantsOf(f.a, 'Dupatta')) as [string];
    for (const variant of [kurta, dupatta]) await f.stock(f.a, variant, 10);
  });

  const latestEntry = async (orderId: string) =>
    (await f.orders.timeline(f.a, orderId, { first: 10 })).items.find((entry) =>
      entry.kind.startsWith('repeat'),
    );

  it('flags an order of the same customer with an item in common, placed days after, not shipped', async () => {
    const first = await f.order(f.a, [kurta]);
    expect(first.repeatOf).toBeNull();

    const second = await f.order(f.a, [kurta, dupatta]);
    expect(second.repeatOf).toEqual({ orderId: first.id, number: first.number, pending: true });
    expect(await latestEntry(second.id)).toMatchObject({
      kind: 'repeat',
      message:
        `May repeat #${first.number}, which the same number placed a minute before with items ` +
        'in common and is not shipped yet: merge it in, cancel it as a repeat, or keep both',
    });

    // Nothing in common, or another customer: not a repeat.
    const other = await f.order(f.a, [dupatta], {
      shippingAddress: { ...ADDRESS, phone: '0321-7654321' },
    });
    expect(other.repeatOf).toBeNull();
    // The latest earlier order with the item in common is the one named.
    const third = await f.order(f.a, [dupatta]);
    expect(third.repeatOf?.orderId).toBe(second.id);
  });

  it('does not flag one after an order shipped, cancelled, or placed more than three days before', async () => {
    const shipped = await f.order(f.a, [kurta]);
    await f.admin.query(`UPDATE orders.orders SET fulfillment_status = 'fulfilled' WHERE id = $1`, [
      shipped.id,
    ]);
    expect((await f.order(f.a, [kurta])).repeatOf).toBeNull();

    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 10);
    const old = await f.order(f.a, [kurta]);
    await f.admin.query(
      `UPDATE orders.orders SET created_at = now() - interval '4 days' WHERE id = $1`,
      [old.id],
    );
    expect((await f.order(f.a, [kurta])).repeatOf).toBeNull();

    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 10);
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    expect((await f.order(f.a, [kurta])).repeatOf).toBeNull();
  });

  it('stops pending once the earlier order ends, as its banner goes', async () => {
    const first = await f.order(f.a, [kurta]);
    const second = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, first.id, { reason: 'customer' }));
    expect((await f.orders.get(f.a, second.id))!.repeatOf).toEqual({
      orderId: first.id,
      number: first.number,
      pending: false,
    });
  });

  it('is kept apart from the earlier order, saying so on its timeline', async () => {
    const first = await f.order(f.a, [kurta]);
    const second = await f.order(f.a, [kurta]);
    const outboxBefore = (await f.outbox()).length;

    const kept = unwrap(await f.orders.keepRepeat(f.a, second.id));
    expect(kept.repeatOf).toBeNull();
    expect((await f.orders.get(f.a, second.id))!.repeatOf).toBeNull();
    expect(await latestEntry(second.id)).toMatchObject({
      kind: 'repeat_kept',
      message: `Kept apart from #${first.number}: not a repeat`,
    });
    const events = (await f.outbox()).slice(outboxBefore);
    expect(events).toMatchObject([
      { event_type: 'order.updated', payload: { changed: ['repeat'] } },
    ]);

    // Again, nothing changes.
    unwrap(await f.orders.keepRepeat(f.a, second.id));
    expect((await f.outbox()).length).toBe(outboxBefore + 1);
  });

  it('is cancelled as a repeat, or merged into the earlier order', async () => {
    const first = await f.order(f.a, [kurta]);
    const second = await f.order(f.a, [kurta]);
    const cancelled = unwrap(await f.orders.cancel(f.a, second.id, { reason: 'duplicate' }));
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'duplicate' });
    const [entry] = (await f.orders.timeline(f.a, second.id, { first: 1 })).items;
    expect(entry!.message).toContain('Cancelled because it repeats another order of its customer');

    const third = await f.order(f.a, [kurta]);
    expect(third.repeatOf?.orderId).toBe(first.id);
    const { order, merged } = unwrap(await f.edits.merge(f.a, third.id, first.id));
    expect(order.lines).toMatchObject([{ variantId: kurta, quantity: 2 }]);
    expect(merged).toMatchObject({ status: 'cancelled', cancelReason: 'merged' });
  });
});
