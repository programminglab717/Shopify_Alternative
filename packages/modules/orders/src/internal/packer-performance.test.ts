import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PackerPerformanceService } from './packer-performance.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('PackerPerformanceService', () => {
  let f: OrdersFixture;
  let packers: PackerPerformanceService;
  let kurta: string;

  /** A packer of `owner`'s shop. */
  const packer = (owner: TenantContext): TenantContext & { actor: { userId: string } } => ({
    ...owner,
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role: 'packer',
    },
  });

  /** A confirmed order of `quantity` kurtas, waiting to be packed. */
  async function toPack(quantity = 1) {
    const order = await f.order(f.a, [kurta], {
      lineItems: [{ variantId: kurta, quantity }],
    });
    return unwrap(await f.orders.confirm(f.a, order.id));
  }

  /** Moves the packing entries on `orderId`'s timeline to `at`. */
  async function packedAt(orderId: string, at: string, kind = 'packed') {
    await f.admin.query(
      'UPDATE orders.order_events SET created_at = $3 WHERE order_id = $1 AND kind = $2',
      [orderId, kind, at],
    );
  }

  /** The last day of September, in Karachi. */
  const day = {
    from: new Date('2026-09-30T00:00:00+05:00'),
    before: new Date('2026-10-01T00:00:00+05:00'),
  };

  beforeAll(async () => {
    f = await ordersFixture(server!);
    packers = new PackerPerformanceService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
  });

  it('counts the orders each packer packed over a period, and the units in them', async () => {
    const [bilal, hina] = [packer(f.a), packer(f.a)];

    // Bilal packs three orders, of 1, 2 and 3 kurtas, at 09:10, 09:40 and 13:05: two hours.
    const [one, two, three] = [await toPack(1), await toPack(2), await toPack(3)];
    for (const [order, at] of [
      [one, '2026-09-30T09:10:00+05:00'],
      [two, '2026-09-30T09:40:00+05:00'],
      [three, '2026-09-30T13:05:00+05:00'],
    ] as const) {
      unwrap(await f.orders.markPacked(bilal, order.id));
      await packedAt(order.id, at);
    }
    // One of them ships, which keeps it his.
    unwrap(await f.fulfillments.fulfill(f.a, three.id, {}));

    // Hina packs two orders that are unpacked again: packing undone is no one's. One of them stays
    // unpacked; Bilal packs the other. And she packs a third, at 10:00, which counts.
    const redone = await toPack(1);
    unwrap(await f.orders.markPacked(hina, redone.id));
    await packedAt(redone.id, '2026-09-30T09:55:00+05:00');
    unwrap(await f.orders.markUnpacked(f.a, redone.id));
    await packedAt(redone.id, '2026-09-30T09:58:00+05:00', 'unpacked');
    const undone = await toPack(4);
    unwrap(await f.orders.markPacked(hina, undone.id));
    await packedAt(undone.id, '2026-09-30T10:20:00+05:00');
    unwrap(await f.orders.markUnpacked(f.a, undone.id));
    await packedAt(undone.id, '2026-09-30T10:30:00+05:00', 'unpacked');
    // Bilal packs the order Hina packed and was unpacked: it is his now.
    unwrap(await f.orders.markPacked(bilal, undone.id));
    await f.admin.query(
      `UPDATE orders.order_events SET created_at = '2026-09-30T13:30:00+05:00'
        WHERE order_id = $1 AND kind = 'packed' AND actor_id = $2`,
      [undone.id, bilal.actor.userId],
    );
    const again = await toPack(1);
    unwrap(await f.orders.markPacked(hina, again.id));
    await packedAt(again.id, '2026-09-30T10:00:00+05:00');

    // An app packing through the API is a packer too.
    const byApp = await toPack(2);
    unwrap(await f.orders.markPacked(f.a, byApp.id));
    await packedAt(byApp.id, '2026-09-30T11:00:00+05:00');
    const appId = (f.a.actor as { tokenId: string }).tokenId;

    // Packing the day before is outside the period.
    const before = await toPack(1);
    unwrap(await f.orders.markPacked(bilal, before.id));
    await packedAt(before.id, '2026-09-29T18:00:00+05:00');

    const report = unwrap(await packers.report(f.a, { ...day, first: 50 }));
    expect(report).toEqual([
      // One, two, three and the one Hina's packing was undone on: 1 + 2 + 3 + 4 units.
      { packer: { kind: 'staff', id: bilal.actor.userId }, packed: 4, units: 10, activeHours: 2 },
      { packer: { kind: 'app', id: appId }, packed: 1, units: 2, activeHours: 1 },
      // Her packing at 09:55 and 10:20 was undone, but she was at it in both hours.
      { packer: { kind: 'staff', id: hina.actor.userId }, packed: 1, units: 1, activeHours: 2 },
    ]);
    expect(
      unwrap(await packers.report(f.a, { ...day, first: 1 })).map((row) => row.packer),
    ).toEqual([{ kind: 'staff', id: bilal.actor.userId }]);
    // A packer's own counts alone.
    expect(
      unwrap(await packers.report(f.a, { ...day, first: 50, onlyStaff: hina.actor.userId })),
    ).toEqual([
      { packer: { kind: 'staff', id: hina.actor.userId }, packed: 1, units: 1, activeHours: 2 },
    ]);
    // Another shop has packed nothing.
    expect(unwrap(await packers.report(f.b, { ...day, first: 50 }))).toEqual([]);
    // The day before has Bilal's one.
    expect(
      unwrap(
        await packers.report(f.a, {
          from: new Date('2026-09-29T00:00:00+05:00'),
          before: day.from,
          first: 50,
        }),
      ),
    ).toEqual([
      { packer: { kind: 'staff', id: bilal.actor.userId }, packed: 1, units: 1, activeHours: 1 },
    ]);
  });

  it('refuses a period that ends before it starts, or is longer than a year', async () => {
    expect(
      errorsOf(await packers.report(f.a, { from: day.before, before: day.from, first: 50 })),
    ).toEqual([['before', 'INVALID']]);
    expect(
      errorsOf(
        await packers.report(f.a, {
          from: new Date('2025-01-01T00:00:00Z'),
          before: new Date('2026-09-30T00:00:00Z'),
          first: 50,
        }),
      ),
    ).toEqual([['before', 'INVALID']]);
  });
});
