import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { Tx } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RiderPageService } from './rider-page.js';
import { DeliveryCodeSender, RIDER_LIMITS, RiderService } from './riders.js';
import { errorsOf, logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const server = testDatabaseServer();

/** Keeps each code it is asked to send. */
class KeptCodes extends DeliveryCodeSender {
  readonly sent: { phone: string; order: string; rider: string; code: string }[] = [];

  async sendIn(_tx: Tx, _shopId: string, message: KeptCodes['sent'][number]) {
    this.sent.push({
      phone: message.phone,
      order: message.order,
      rider: message.rider,
      code: message.code,
    });
    return true;
  }
}

describe.skipIf(!server)("The shop's own riders (SHP-10, ADR-824)", () => {
  let f: LogisticsFixture;
  let codes: KeptCodes;
  let riders: RiderService;
  let kurta: string;

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
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
  });

  it('adds riders with a link of their own, kept as its digest, and changes them', async () => {
    expect(errorsOf(await riders.create(f.a, { name: ' ', phone: '12345' }))).toEqual([
      ['input.name', 'INVALID'],
      ['input.phone', 'INVALID'],
    ]);
    const { rider, link } = unwrap(
      await riders.create(f.a, { name: ' Asif ', phone: '0300-1112223' }),
    );
    expect(rider).toMatchObject({
      name: 'Asif',
      phone: '+923001112223',
      active: true,
      out: 0,
      cashHeld: 0n,
    });
    expect(link).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const kept = async () =>
      (
        await f.admin.query<{ link_hash: Buffer }>(
          'SELECT link_hash FROM logistics.riders WHERE id = $1',
          [rider.id],
        )
      ).rows[0]!.link_hash;
    expect(await kept()).toEqual(createHash('sha256').update(link).digest());
    // A new link: the old one works no more.
    const fresh = unwrap(await riders.newLink(f.a, rider.id));
    expect(fresh).not.toBe(link);
    expect(await kept()).toEqual(createHash('sha256').update(fresh).digest());

    const changed = unwrap(
      await riders.update(f.a, rider.id, { name: 'Asif Ali', phone: '03001112223', active: false }),
    );
    expect(changed).toMatchObject({ name: 'Asif Ali', active: false });
    expect((await riders.list(f.a)).map((each) => each.name)).toEqual(['Asif Ali']);
    // Another shop's is none of this one's.
    expect(await riders.get(f.b, rider.id)).toBeNull();
    expect(errorsOf(await riders.newLink(f.b, rider.id))).toEqual([['id', 'NOT_FOUND']]);
  });

  it(`keeps ${RIDER_LIMITS.perShop} riders a shop at most`, async () => {
    await f.admin.query(
      `INSERT INTO logistics.riders (shop_id, name, phone, link_hash)
       SELECT $1, 'Rider ' || n, '+92300000' || lpad(n::text, 4, '0'), sha256(n::text::bytea)
         FROM generate_series(1, $2::int) n`,
      [f.a.shopId, RIDER_LIMITS.perShop],
    );
    expect(errorsOf(await riders.create(f.a, { name: 'One more', phone: '03001112223' }))).toEqual([
      ['input', 'TOO_MANY'],
    ]);
  });

  it('hands orders to a rider: each shipped with them, its cash theirs to collect, its customer sent a code', async () => {
    const { rider } = unwrap(await riders.create(f.a, { name: 'Asif', phone: '03001112223' }));
    const first = await f.confirmed(f.a, kurta, { quantity: 2 });
    const unconfirmed = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: {
          name: 'Bilal',
          phone: '0321 7654321',
          address1: 'House 1',
          city: 'Lahore',
        },
      }),
    );
    const results = unwrap(await riders.handOut(f.a, rider.id, [first.orderId, unconfirmed.id]));
    expect(results).toEqual([
      {
        orderId: first.orderId,
        delivery: expect.objectContaining({
          riderId: rider.id,
          status: 'out',
          cashDue: 4_000_00n,
          cashCollected: 0n,
          codeSent: true,
          codeGiven: false,
        }),
      },
      { orderId: unconfirmed.id, problem: expect.stringMatching(/confirm/i) },
    ]);
    // Shipped with the rider as its courier.
    const { rows: parcels } = await f.admin.query<{
      tracking_company: string;
      tracking_number: string;
      status: string;
    }>(
      'SELECT tracking_company, tracking_number, status FROM orders.fulfillments WHERE order_id = $1',
      [first.orderId],
    );
    expect(parcels).toEqual([
      {
        tracking_company: "A's rider Asif",
        tracking_number: expect.stringMatching(/^R-[0-9A-F]{10}$/),
        status: 'in_transit',
      },
    ]);
    // Its customer sent a code, kept only as its digest.
    expect(codes.sent).toEqual([
      {
        phone: '+923001234567',
        order: `#${first.number}`,
        rider: 'Asif',
        code: expect.stringMatching(/^\d{4}$/),
      },
    ]);
    const { rows: kept } = await f.admin.query<{ code_hash: Buffer }>(
      'SELECT code_hash FROM logistics.rider_deliveries WHERE order_id = $1',
      [first.orderId],
    );
    expect(kept[0]!.code_hash).toEqual(createHash('sha256').update(codes.sent[0]!.code).digest());
    expect((await riders.get(f.a, rider.id))!.out).toBe(1);
    expect(
      (await riders.deliveries(f.a, { riderId: rider.id })).map((each) => each.orderId),
    ).toEqual([first.orderId]);

    // Not to a rider who rides for the shop no more, nor too many at once.
    unwrap(
      await riders.update(f.a, rider.id, { name: 'Asif', phone: '03001112223', active: false }),
    );
    expect(errorsOf(await riders.handOut(f.a, rider.id, [unconfirmed.id]))).toEqual([
      ['riderId', 'INVALID'],
    ]);
    expect(errorsOf(await riders.handOut(f.a, rider.id, []))).toEqual([['orderIds', 'BLANK']]);
  });

  it('sends no code where it cannot, and the delivery says so', async () => {
    const plain = new RiderService(f.db, f.fulfillments);
    const { rider } = unwrap(await plain.create(f.a, { name: 'Asif', phone: '03001112223' }));
    const order = await f.confirmed(f.a, kurta);
    const [result] = unwrap(await plain.handOut(f.a, rider.id, [order.orderId]));
    expect(result).toMatchObject({ delivery: { codeSent: false } });
  });

  it('records the cash a rider hands over, at most what they hold (ADR-826)', async () => {
    const { rider, link } = unwrap(
      await riders.create(f.a, { name: 'Asif', phone: '03001112223' }),
    );
    const order = await f.confirmed(f.a, kurta, { quantity: 2 });
    const [handed] = unwrap(await riders.handOut(f.a, rider.id, [order.orderId]));
    if (!handed || !('delivery' in handed)) throw new Error(JSON.stringify(handed));
    const pages = new RiderPageService(f.db, f.fulfillments);
    expect(await pages.deliver(link, handed.delivery.id, { code: '', cash: '4000' })).toEqual({
      ok: true,
    });
    expect((await riders.get(f.a, rider.id))!.cashHeld).toBe(4_000_00n);

    expect(errorsOf(await riders.handOver(f.a, rider.id, { amount: 5_000_00n }))).toEqual([
      ['input.amount', 'INVALID'],
    ]);
    expect(errorsOf(await riders.handOver(f.a, rider.id, { amount: 0n }))).toEqual([
      ['input.amount', 'INVALID'],
    ]);
    const first = unwrap(
      await riders.handOver(f.a, rider.id, { amount: 3_000_00n, note: ' Evening run ' }),
    );
    expect(first).toMatchObject({
      riderId: rider.id,
      amount: 3_000_00n,
      note: 'Evening run',
      receivedByKind: 'app',
    });
    expect((await riders.get(f.a, rider.id))!.cashHeld).toBe(1_000_00n);
    // Two at once take no more than they hold.
    const both = await Promise.all([
      riders.handOver(f.a, rider.id, { amount: 1_000_00n }),
      riders.handOver(f.a, rider.id, { amount: 1_000_00n }),
    ]);
    expect(both.filter((each) => each.ok)).toHaveLength(1);
    expect((await riders.get(f.a, rider.id))!.cashHeld).toBe(0n);
    expect((await riders.handovers(f.a, rider.id)).map((each) => each.amount)).toEqual([
      1_000_00n,
      3_000_00n,
    ]);
    // Another shop's rider is none of this one's.
    expect(errorsOf(await riders.handOver(f.b, rider.id, { amount: 1n }))).toEqual([
      ['riderId', 'NOT_FOUND'],
    ]);
  });
});
