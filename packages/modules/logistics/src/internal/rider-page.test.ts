import 'reflect-metadata';
import type { Tx } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RiderPageService, riderPage } from './rider-page.js';
import { DeliveryCodeSender, RIDER_LIMITS, RiderService } from './riders.js';
import { logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const server = testDatabaseServer();

/** Keeps each code it is asked to send. */
class KeptCodes extends DeliveryCodeSender {
  readonly codes: string[] = [];

  async sendIn(_tx: Tx, _shopId: string, message: { code: string }) {
    this.codes.push(message.code);
    return true;
  }
}

describe.skipIf(!server)("A rider's page (APP-06, ADR-825)", () => {
  let f: LogisticsFixture;
  let codes: KeptCodes;
  let riders: RiderService;
  let pages: RiderPageService;
  let kurta: string;
  let link: string;
  let riderId: string;

  beforeAll(async () => {
    f = await logisticsFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    codes = new KeptCodes();
    riders = new RiderService(f.db, f.fulfillments, codes);
    pages = new RiderPageService(f.db, f.fulfillments);
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
    const made = unwrap(await riders.create(f.a, { name: 'Asif', phone: '03001112223' }));
    link = made.link;
    riderId = made.rider.id;
  });

  /** A confirmed order of two kurtas handed to the rider: its delivery's ID and the code sent. */
  async function handedOut() {
    const order = await f.confirmed(f.a, kurta, { quantity: 2 });
    const [result] = unwrap(await riders.handOut(f.a, riderId, [order.orderId]));
    if (!result || !('delivery' in result)) throw new Error(JSON.stringify(result));
    return { ...order, deliveryId: result.delivery.id, code: codes.codes.at(-1)! };
  }

  const parcelOf = async (orderId: string) =>
    (
      await f.admin.query<{ status: string }>(
        'SELECT status FROM orders.fulfillments WHERE order_id = $1',
        [orderId],
      )
    ).rows[0]!.status;

  it('lists what the rider carries, with its address, map and number, and nothing for a link that is none', async () => {
    const order = await handedOut();
    const view = (await pages.view(link))!;
    expect(view).toMatchObject({ shop: 'A', rider: 'Asif', delivered: 0, failed: 0, cashHeld: 0n });
    expect(view.stops).toEqual([
      {
        delivery: expect.objectContaining({ id: order.deliveryId, cashDue: 4_000_00n }),
        order: `#${order.number}`,
        customer: 'Ayesha Khan',
        phone: '+923001234567',
        lines: ['House 12, Street 4', 'Gulberg III', 'near Liberty Market', 'Lahore'],
        mapUrl:
          'https://www.google.com/maps/search/?api=1&query=House%2012%2C%20Street%204%2C%20Gulberg%20III%2C%20near%20Liberty%20Market%2C%20Lahore',
      },
    ]);
    const html = riderPage(view, link);
    expect(html).toContain(
      `<form method="post" action="/rider/${link}/${order.deliveryId}/delivered">`,
    );
    expect(html).toContain('href="tel:+923001234567"');
    expect(html).toContain('href="https://wa.me/923001234567"');
    expect(html).toContain('Collect Rs 4,000');
    expect(await pages.view('x'.repeat(22))).toBeNull();
    expect(await pages.view('short')).toBeNull();
    // A rider who rides no more has no page.
    unwrap(
      await riders.update(f.a, riderId, { name: 'Asif', phone: '03001112223', active: false }),
    );
    expect(await pages.view(link)).toBeNull();
  });

  it("delivers with the customer's code and the cash collected, the cash received on its order", async () => {
    const order = await handedOut();
    expect(await pages.deliver(link, order.deliveryId, { code: '', cash: '5,000' })).toEqual({
      refused: 'cash',
    });
    const wrong = order.code === '0000' ? '1111' : '0000';
    expect(await pages.deliver(link, order.deliveryId, { code: wrong, cash: '4000' })).toEqual({
      refused: 'code',
    });
    expect(
      await pages.deliver(link, order.deliveryId, { code: order.code, cash: '4,000' }),
    ).toEqual({
      ok: true,
    });
    expect(await parcelOf(order.orderId)).toBe('delivered');
    const { rows } = await f.admin.query<{ amount_paid: string; financial_status: string }>(
      'SELECT amount_paid::text, financial_status FROM orders.orders WHERE id = $1',
      [order.orderId],
    );
    expect(rows[0]).toEqual({ amount_paid: '400000', financial_status: 'paid' });
    const [delivery] = await riders.deliveries(f.a, { riderId });
    expect(delivery).toMatchObject({
      status: 'delivered',
      cashCollected: 4_000_00n,
      codeGiven: true,
      deliveredAt: expect.any(Date),
    });
    // The cash is the rider's to hand over; done, it is changed no more.
    expect((await pages.view(link))!).toMatchObject({
      delivered: 1,
      cashHeld: 4_000_00n,
      stops: [],
    });
    expect(await pages.deliver(link, order.deliveryId, { code: order.code, cash: '4000' })).toEqual(
      {
        refused: 'none',
      },
    );
  });

  it('takes so many tries at the code, and delivers without one where the customer lost it', async () => {
    const order = await handedOut();
    const wrong = order.code === '0000' ? '1111' : '0000';
    for (let tried = 0; tried < RIDER_LIMITS.codeTries; tried++) {
      await pages.deliver(link, order.deliveryId, { code: wrong, cash: '4000' });
    }
    expect(await pages.deliver(link, order.deliveryId, { code: order.code, cash: '4000' })).toEqual(
      {
        refused: 'tries',
      },
    );
    expect(await pages.deliver(link, order.deliveryId, { code: '', cash: '3500' })).toEqual({
      ok: true,
    });
    const [delivery] = await riders.deliveries(f.a, { riderId });
    expect(delivery).toMatchObject({ codeGiven: false, cashCollected: 3_500_00n });
    // Paid in part, the rest owed.
    const { rows } = await f.admin.query<{ financial_status: string }>(
      'SELECT financial_status FROM orders.orders WHERE id = $1',
      [order.orderId],
    );
    expect(rows[0]!.financial_status).toBe('partially_paid');
  });

  it('records a delivery not made, and why: its parcel comes back with the rider', async () => {
    const order = await handedOut();
    expect(await pages.fail(link, order.deliveryId, 'nonsense')).toEqual({ refused: 'none' });
    expect(await pages.fail(link, order.deliveryId, 'not_home')).toEqual({ ok: true });
    expect(await parcelOf(order.orderId)).toBe('returning');
    const [delivery] = await riders.deliveries(f.a, { riderId });
    expect(delivery).toMatchObject({ status: 'failed', failedReason: 'No one was home' });
    expect((await pages.view(link))!.failed).toBe(1);
    // Another rider's link changes none of this rider's.
    const other = unwrap(await riders.create(f.a, { name: 'Bilal', phone: '03211112223' }));
    const next = await handedOut();
    expect(await pages.fail(other.link, next.deliveryId, 'refused')).toEqual({ refused: 'none' });
  });
});
