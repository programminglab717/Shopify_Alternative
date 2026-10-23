import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AffiliatesService } from './affiliates.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Affiliates (MKT-08, ADR-776)', () => {
  let f: OrdersFixture;
  let affiliates: AffiliatesService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    affiliates = new AffiliatesService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  const visit = (landingPage: string) => ({
    at: new Date().toISOString(),
    source: 'direct',
    utm: null,
    landingPage,
  });

  /** An order of a 2,000 kurta, as the shop came by it: a code, its visits, its stage. */
  async function orderOf(options: {
    code?: string;
    first?: string;
    last?: string;
    stage?: string;
    discount?: number;
  }) {
    const order = await f.order(f.a, [kurta]);
    await f.admin.query(
      `UPDATE orders.orders
          SET discount_codes = $2, attribution = $3, stage = $4, discount = $5,
              total = total - $5, cod_amount = cod_amount - $5
        WHERE id = $1`,
      [
        order.id,
        options.code ? [options.code] : [],
        options.first || options.last
          ? {
              first: visit(options.first ?? options.last!),
              last: visit(options.last ?? options.first!),
            }
          : null,
        options.stage ?? 'delivered',
        options.discount ?? 0,
      ],
    );
    return order;
  }

  const report = async (ref: string) =>
    (await affiliates.list(f.a)).find((each) => each.ref === ref)!;

  it('gives an affiliate the orders placed with their code, or from their link, and their share once delivered', async () => {
    // Orders before an affiliate was added are not theirs.
    await orderOf({ code: 'AYESHA10' });
    await f.admin.query(`UPDATE orders.orders SET created_at = now() - interval '1 day'`);
    const ayesha = unwrap(
      await affiliates.create(f.a, {
        name: 'Ayesha Khan',
        phone: '0300 1234567',
        ref: ' Ayesha ',
        discountCode: 'ayesha10',
        commission: '10',
      }),
    );
    expect(ayesha).toMatchObject({
      phone: '+923001234567',
      ref: 'ayesha',
      discountCode: 'AYESHA10',
      commissionBps: 1000,
      endedAt: null,
    });
    const bilal = unwrap(
      await affiliates.create(f.a, { name: 'Bilal', ref: 'bilal', commission: '7.5' }),
    );

    // Hers by code, in any letter case, whatever brought the customer; 200 off leaves 1,800.
    await orderOf({ code: 'Ayesha10', last: 'https://shop.example/?ref=bilal', discount: 20_000 });
    // Hers by her link, the last visit's; the first visit's counts when the last isn't anyone's.
    await orderOf({ last: 'https://shop.example/products/kurta?utm_source=ig&ref=AYESHA' });
    await orderOf({ first: 'https://shop.example/?ref=ayesha', last: 'https://shop.example/' });
    // Still on its way: pending. Returned or cancelled: nothing.
    await orderOf({ code: 'AYESHA10', stage: 'in_transit' });
    await orderOf({ code: 'AYESHA10', stage: 'returned' });
    const cancelled = await orderOf({ code: 'AYESHA10', stage: 'needs_confirmation' });
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    // Bilal's by his link, and another's ref is no one's.
    await orderOf({ last: 'https://shop.example/?ref=bilal' });
    await orderOf({ last: 'https://shop.example/?ref=nobody' });

    expect((await report('ayesha')).stats).toEqual({
      orders: 5,
      delivered: 3,
      sales: 580_000n,
      earned: 58_000n,
      pending: 20_000n,
      paid: 0n,
      owed: 58_000n,
    });
    expect((await report('bilal')).stats).toMatchObject({
      orders: 1,
      delivered: 1,
      sales: 200_000n,
      earned: 15_000n,
    });

    const orders = await affiliates.orders(f.a, ayesha.id);
    expect(orders.map((order) => [order.by, order.stage, order.base, order.commission])).toEqual([
      ['code', 'returned', 200_000n, 20_000n],
      ['code', 'in_transit', 200_000n, 20_000n],
      ['link', 'delivered', 200_000n, 20_000n],
      ['link', 'delivered', 200_000n, 20_000n],
      ['code', 'delivered', 180_000n, 18_000n],
    ]);

    // What the shop paid comes off what is owed.
    const paid = unwrap(
      await affiliates.recordPayout(f.a, {
        affiliateId: ayesha.id,
        amount: '500',
        note: 'JazzCash',
      }),
    );
    expect(paid).toMatchObject({ amount: 50_000n, note: 'JazzCash' });
    expect((await report('ayesha')).stats).toMatchObject({ paid: 50_000n, owed: 8_000n });
    expect(await affiliates.payouts(f.a, ayesha.id)).toHaveLength(1);
    expect(
      errorsOf(await affiliates.recordPayout(f.a, { affiliateId: ayesha.id, amount: '0' })),
    ).toEqual([['input.amount', 'INVALID']]);
    // Another shop can't pay them.
    expect(
      errorsOf(await affiliates.recordPayout(f.b, { affiliateId: bilal.id, amount: '1' })),
    ).toEqual([['input.affiliateId', 'NOT_FOUND']]);
  });

  it('ends an affiliate’s part, after which their orders earn nothing, and checks what it keeps', async () => {
    const zara = unwrap(
      await affiliates.create(f.a, { name: 'Zara', ref: 'zara', commission: '12.25' }),
    );
    const before = await orderOf({ last: 'https://shop.example/?ref=zara' });
    const ended = unwrap(await affiliates.update(f.a, zara.id, { active: false }));
    expect(ended.endedAt).toBeInstanceOf(Date);
    await f.admin.query(
      `UPDATE orders.affiliates
          SET created_at = now() - interval '1 hour', ended_at = now() - interval '1 minute';
       UPDATE orders.orders SET created_at = now() - interval '30 minutes' WHERE id = '${before.id}'`,
    );
    await orderOf({ last: 'https://shop.example/?ref=zara' });
    expect((await report('zara')).stats).toMatchObject({ orders: 1, earned: 24_500n });

    // A link or code another affiliate has is refused; so is a share past 50% or a bad ref.
    expect(
      errorsOf(await affiliates.create(f.a, { name: 'Z', ref: 'ZARA', commission: '5' })),
    ).toEqual([['input.ref', 'TAKEN']]);
    unwrap(
      await affiliates.create(f.a, {
        name: 'Hina',
        ref: 'hina',
        discountCode: 'HINA',
        commission: '5',
      }),
    );
    expect(errorsOf(await affiliates.update(f.a, zara.id, { discountCode: 'hina' }))).toEqual([
      ['input.discountCode', 'TAKEN'],
    ]);
    expect(
      errorsOf(
        await affiliates.create(f.a, { name: '', ref: 'a b', commission: '50.01', phone: '12' }),
      ),
    ).toEqual([
      ['input.name', 'BLANK'],
      ['input.phone', 'INVALID'],
      ['input.ref', 'INVALID'],
      ['input.commission', 'INVALID'],
    ]);
    expect(errorsOf(await affiliates.update(f.a, zara.id, { commission: '0' }))).toEqual([
      ['input.commission', 'INVALID'],
    ]);
    // Changes are events, with what changed; what changed nothing is none.
    unwrap(await affiliates.update(f.a, zara.id, { commission: '12.25', active: true }));
    const events = (await f.outbox())
      .filter((event) => event.event_type.startsWith('affiliate.'))
      .map((event) => [event.event_type, event.payload]);
    expect(events).toEqual([
      ['affiliate.created', { changed: [] }],
      ['affiliate.updated', { changed: ['active'] }],
      ['affiliate.created', { changed: [] }],
      ['affiliate.updated', { changed: ['active'] }],
    ]);
    // Another shop's affiliates are its own.
    expect(await affiliates.list(f.b)).toEqual([]);
    expect(await affiliates.get(f.b, zara.id)).toBeNull();
  });
});
