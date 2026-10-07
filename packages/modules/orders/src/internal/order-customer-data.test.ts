import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionValue } from './attribution.js';
import type { BrowserIdsValue } from './browser-ids.js';
import { ConfirmationDeskService } from './confirmation-desk.service.js';
import { toOrder } from './graphql/mappers.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

const SECOND_SIM = { ...ADDRESS, phone: '0311 1234567' };

/** What the shop's Meta pixel named the customer's browser by, in checkout (ADR-144). */
const BROWSER_IDS: BrowserIdsValue = {
  fbp: 'fb.1.1727856000000.1116446470',
  fbc: 'fb.1.1727856000000.IwAR2x',
};

/** Where a customer came from before placing an order through checkout (ADR-139). */
const ATTRIBUTION: AttributionValue = {
  first: {
    at: '2026-09-30T08:00:00.000Z',
    source: 'instagram',
    utm: { source: null, medium: null, campaign: 'eid', term: null, content: null },
    landingPage: 'https://zari.pk/products/kurta?utm_campaign=eid&fbclid=IwAR0',
    referrer: 'https://l.instagram.com/',
  },
  last: {
    at: '2026-10-01T08:00:00.000Z',
    source: 'google',
    utm: null,
    landingPage: 'https://zari.pk/',
    referrer: 'https://www.google.com/',
  },
};

describe.skipIf(!server)('Orders when customers merge, are erased or have their data', () => {
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
    await f.stock(f.a, kurta, 50);
  });

  /** Ships an order in one parcel, confirming it first if it needs confirming. */
  async function ship(orderId: string): Promise<string> {
    const order = unwrap(await f.orders.confirm(f.a, orderId));
    return unwrap(await f.fulfillments.fulfill(f.a, order.id, {})).fulfillmentId;
  }

  it("moves a duplicate's orders to the customer, so their history counts together", async () => {
    const refused = await f.order(f.a, [kurta]);
    const parcel = await ship(refused.id);
    unwrap(await f.fulfillments.markReturning(f.a, parcel));
    unwrap(await f.fulfillments.receiveReturn(f.a, parcel));
    const other = await f.order(f.a, [kurta], { shippingAddress: SECOND_SIM });
    expect(other.customerId).not.toBe(refused.customerId);

    unwrap(await f.customerData.merge(f.a, refused.customerId, other.customerId));
    const moved = (await f.orders.get(f.a, other.id))!;
    expect(moved).toMatchObject({ customerId: refused.customerId, version: other.version + 1 });
    const stats = await f.orders.customerStats(f.a, [refused.customerId]);
    expect(stats.get(refused.customerId)).toMatchObject({ count: 2, returned: 1, inProgress: 1 });

    // The next order from the second SIM is the customer's, and the refusal on the other number
    // counts towards its risk.
    const next = await f.order(f.a, [kurta], { shippingAddress: SECOND_SIM });
    expect(next).toMatchObject({ customerId: refused.customerId, stage: 'needs_review' });
    expect(next.risk!.reasons.map((reason) => reason.code)).toEqual([
      'refused_deliveries',
      'recent_order',
    ]);
  });

  it("erases the customer's details from their orders, and keeps what the accounts need", async () => {
    const completed = await f.order(f.a, [kurta], {
      email: 'ayesha@example.com',
      note: 'Ring twice; her name is on the gate',
      // Her phone's pin at the address (ADR-259).
      shippingAddress: { ...ADDRESS, latitude: '24.920400', longitude: '67.093200' },
    });
    // Placed through checkout, it keeps what she agreed to, where she placed it from, the visits
    // that brought her and the IDs the shop's Meta pixel gave her browser.
    const version = '01a0f3b1-9685-7065-988d-604298214e34';
    await f.admin.query(
      `UPDATE orders.orders
          SET agreed_policy_versions = ARRAY[$2::uuid], agreed_at = created_at,
              client_ip = '203.0.113.7', client_user_agent = 'Mozilla/5.0 (Linux; Android 14)',
              attribution = $3, browser_ids = $4
        WHERE id = $1`,
      [completed.id, version, JSON.stringify(ATTRIBUTION), JSON.stringify(BROWSER_IDS)],
    );
    const parcel = await ship(completed.id);
    // The words on its way may name her too (ADR-160).
    unwrap(
      await f.fulfillments.recordEvent({ shopId: f.a.shopId, actor: 'system' }, parcel, {
        status: 'out_for_delivery',
        message: 'Rider called Ayesha',
        sourceKey: 'test:erasure',
      }),
    );
    unwrap(await f.fulfillments.markDelivered(f.a, parcel));
    unwrap(await f.orders.markAsPaid(f.a, completed.id));
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const open = await f.order(f.a, [kurta]);
    // An agent's note on a call to confirm it may name her plans.
    unwrap(
      await new ConfirmationDeskService(f.db).recordCall(f.a, open.id, {
        outcome: 'call_back',
        callBackAt: new Date(Date.now() + 3_600_000),
        note: "Ayesha is at her sister's until Friday",
      }),
    );
    // So may a comment staff wrote on her order; another customer's order keeps its own.
    unwrap(
      await f.comments.create(f.a, completed.id, 'Ayesha asked us to leave it with the guard'),
    );
    const bilals = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, name: 'Bilal Ahmed', phone: '0345 7654321' },
    });
    unwrap(await f.comments.create(f.a, bilals.id, 'Bilal pays exact change'));
    // Another shop's customer with the same number is someone else's to erase.
    const [shawl] = (await f.variantsOf(f.b, 'Shawl')) as [string];
    await f.stock(f.b, shawl, 5);
    const elsewhere = await f.order(f.b, [shawl]);

    // Not while an order is still under way.
    expect(await f.customerData.erase(f.a, completed.customerId)).toEqual({
      ok: false,
      errors: [
        {
          field: ['id'],
          code: 'IN_USE',
          message: `Their orders must be closed or cancelled first; still open: #${open.number}`,
        },
      ],
    });
    unwrap(await f.orders.cancel(f.a, open.id, { reason: 'customer' }));
    unwrap(await f.customerData.erase(f.a, completed.customerId));
    const { rows: calls } = await f.admin.query<{ outcome: string; note: string }>(
      'SELECT outcome, note FROM orders.confirmation_calls WHERE order_id = $1',
      [open.id],
    );
    expect(calls).toEqual([{ outcome: 'call_back', note: '' }]);
    const { rows: comments } = await f.admin.query<{ order_id: string; message: string }>(
      'SELECT order_id, message FROM orders.order_comments ORDER BY id',
    );
    expect(comments).toEqual([{ order_id: bilals.id, message: 'Bilal pays exact change' }]);
    const { rows: steps } = await f.admin.query<{ status: string; message: string | null }>(
      'SELECT status, message FROM orders.fulfillment_events WHERE fulfillment_id = $1',
      [parcel],
    );
    expect(steps).toEqual([{ status: 'out_for_delivery', message: null }]);

    const erased = (await f.orders.get(f.a, completed.id))!;
    // Her pin goes with the rest of the address.
    expect(erased.shippingAddress.location).toBeNull();
    expect(erased).toMatchObject({
      phone: null,
      email: null,
      note: '',
      shippingAddress: {
        name: null,
        phone: null,
        address1: null,
        address2: null,
        landmark: null,
        city: 'Karachi',
        provinceCode: 'SD',
        zip: null,
      },
      // Where she placed it from goes; what she agreed to is the shop's words, and stays.
      agreement: {
        policyVersions: [version],
        agreedAt: completed.createdAt,
        ip: null,
        userAgent: null,
      },
      // The rest stays, for the accounts.
      number: completed.number,
      total: 200_000n,
      amountPaid: 200_000n,
      stage: 'completed',
      lines: [{ title: 'Kurta', quantity: 1 }],
    });
    expect(erased.customerErasedAt).toBeInstanceOf(Date);
    const { rows: browsers } = await f.admin.query<{ browser_ids: unknown }>(
      'SELECT browser_ids FROM orders.orders WHERE id = $1',
      [completed.id],
    );
    expect(browsers).toEqual([{ browser_ids: null }]);
    // The pages she landed on and came from go; where she came from stays, for the campaigns.
    const journey = (await f.orders.attributionsOf(f.a, [completed.id])).get(completed.id)!;
    expect([journey.firstVisit, journey.lastVisit]).toEqual([
      {
        occurredAt: new Date(ATTRIBUTION.first.at),
        source: 'instagram',
        utm: ATTRIBUTION.first.utm,
        landingPage: null,
        referrerUrl: null,
      },
      {
        occurredAt: new Date(ATTRIBUTION.last.at),
        source: 'google',
        utm: null,
        landingPage: null,
        referrerUrl: null,
      },
    ]);
    expect(toOrder(erased, f.a)).toMatchObject({
      phone: null,
      shippingAddress: { name: null, phone: null, formatted: ['Karachi', 'Sindh'] },
    });
    const timeline = await f.orders.timeline(f.a, completed.id, { first: 1 });
    expect(timeline.items.map((entry) => [entry.kind, entry.actorKind, entry.message])).toEqual([
      ['erased', 'app', "The customer's details were erased at their request"],
    ]);
    for (const order of [cancelled, open]) {
      expect(await f.orders.get(f.a, order.id)).toMatchObject({ phone: null, email: null });
    }
    // Searches no longer find them by name or number.
    expect((await f.orders.list(f.a, { first: 10, query: 'ayesha' })).items).toEqual([]);
    expect((await f.orders.list(f.a, { first: 10, query: '0300 1234567' })).items).toEqual([]);

    // Their details cannot come back through an edit; notes and tags are the shop's.
    expect(
      errorsOf(await f.orders.update(f.a, completed.id, { email: 'ayesha@example.com' })),
    ).toEqual([['input.email', 'INVALID']]);
    unwrap(await f.orders.update(f.a, completed.id, { tags: ['audited'] }));

    // A new order from the same number starts afresh: a new customer, with no history.
    const again = await f.order(f.a, [kurta]);
    expect(again.customerId).not.toBe(completed.customerId);
    expect(again.risk!.reasons.map((reason) => reason.code)).toEqual(['first_order']);
    expect(await f.orders.get(f.b, elsewhere.id)).toMatchObject({ phone: '+923001234567' });
  });

  it("gives a customer their orders and drafts whole, without the shop's defences", async () => {
    const delivered = await f.order(f.a, [kurta], {
      email: 'ayesha@example.com',
      note: 'Ring twice',
      tags: ['gift'],
      shippingAddress: { ...ADDRESS, latitude: 24.9204, longitude: 67.0932 },
    });
    const version = '01a0f3b1-9685-7065-988d-604298214e34';
    await f.admin.query(
      `UPDATE orders.orders
          SET agreed_policy_versions = ARRAY[$2::uuid], agreed_at = created_at,
              client_ip = '203.0.113.7', client_user_agent = 'Mozilla/5.0 (Linux; Android 14)',
              attribution = $3, browser_ids = $4
        WHERE id = $1`,
      [delivered.id, version, JSON.stringify(ATTRIBUTION), JSON.stringify(BROWSER_IDS)],
    );
    const parcel = await ship(delivered.id);
    unwrap(await f.fulfillments.markDelivered(f.a, parcel));
    unwrap(await f.orders.markAsPaid(f.a, delivered.id));
    unwrap(
      await f.refunds.refund(f.a, delivered.id, {
        amount: '500',
        method: 'bank_transfer',
        reference: 'IBFT-778812',
        note: 'Stitching came apart',
      }),
    );
    // A second order, with a call to confirm it and a receipt she sent for its advance.
    const second = await f.order(f.a, [kurta]);
    const callBackAt = new Date(Date.now() + 3_600_000);
    unwrap(
      await new ConfirmationDeskService(f.db).recordCall(f.a, second.id, {
        outcome: 'call_back',
        callBackAt,
        note: "At her sister's until Friday",
      }),
    );
    const receipt = newId();
    await f.admin.query(
      `INSERT INTO orders.transfer_receipts (shop_id, id, order_id, key, content_type, size)
       VALUES ($1, $2, $3, $4, 'image/jpeg', 48213)`,
      [f.a.shopId, receipt, second.id, `shops/${f.a.shopId}/receipts/${second.id}/${receipt}.jpg`],
    );
    // A draft taken in a chat with her number, not placed yet.
    const draft = unwrap(
      await f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 2, price: '1,800' }],
        shippingAddress: ADDRESS,
      }),
    );
    // Someone else's order and draft are theirs.
    const bilal = { ...ADDRESS, name: 'Bilal Ahmed', phone: '0345 7654321' };
    await f.order(f.a, [kurta], { shippingAddress: bilal });
    unwrap(
      await f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: bilal,
      }),
    );

    // Comments on her orders are the shop's record of its work, as the timeline is.
    unwrap(await f.comments.create(f.a, delivered.id, 'She takes calls after 5pm'));

    const file = JSON.parse(
      unwrap(await f.customerData.export(f.a, delivered.customerId)).json,
    ) as Record<string, unknown>;
    expect(JSON.stringify(file)).not.toContain('after 5pm');
    const at = expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) as string;
    const final = (await f.orders.get(f.a, delivered.id))!;
    expect(file.orders).toEqual([
      {
        id: toPublicId('order', delivered.id),
        name: `#${delivered.number}`,
        placedAt: delivered.createdAt.toISOString(),
        source: 'api',
        status: final.status,
        confirmationStatus: 'confirmed',
        financialStatus: final.financialStatus,
        fulfillmentStatus: 'fulfilled',
        paymentMethod: 'cash_on_delivery',
        currency: 'PKR',
        lineItems: [
          {
            title: 'Kurta',
            variantTitle: final.lines[0]!.variantTitle,
            sku: null,
            quantity: 1,
            unitPrice: '2000.00',
            total: '2000.00',
          },
        ],
        subtotal: '2000.00',
        discount: '0.00',
        discountCodes: [],
        shipping: '0.00',
        codFee: '0.00',
        tax: '0.00',
        total: '2000.00',
        paid: '2000.00',
        refunded: '500.00',
        phone: '+923001234567',
        email: 'ayesha@example.com',
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '+923001234567',
          address1: 'House 12, Street 4, Block 5',
          address2: 'Gulshan-e-Iqbal',
          landmark: 'Near Jamia Masjid',
          city: 'Karachi',
          province: 'Sindh',
          zip: '75300',
          latitude: 24.9204,
          longitude: 67.0932,
        },
        note: 'Ring twice',
        tags: ['gift'],
        agreement: {
          policyVersionIds: [toPublicId('shopPolicyVersion', version)],
          agreedAt: delivered.createdAt.toISOString(),
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0 (Linux; Android 14)',
        },
        // The visits that brought her, as the Admin API gives them.
        visits: {
          first: {
            occurredAt: ATTRIBUTION.first.at,
            source: 'instagram',
            utmParameters: ATTRIBUTION.first.utm,
            landingPage: ATTRIBUTION.first.landingPage,
            referrerUrl: 'https://l.instagram.com/',
          },
          last: {
            occurredAt: ATTRIBUTION.last.at,
            source: 'google',
            utmParameters: null,
            landingPage: 'https://zari.pk/',
            referrerUrl: 'https://www.google.com/',
          },
        },
        // And what the shop's Meta pixel named her browser by (ADR-144).
        browserIds: BROWSER_IDS,
        confirmedAt: at,
        paidAt: at,
        cancelledAt: null,
        cancelReason: null,
        closedAt: final.closedAt?.toISOString() ?? null,
        parcels: [
          {
            id: toPublicId('fulfillment', parcel),
            status: 'delivered',
            courier: null,
            trackingNumber: null,
            trackingUrl: null,
            shippedAt: at,
            deliveredAt: at,
            returningAt: null,
            returnedAt: null,
            lostAt: null,
          },
        ],
        refunds: [
          {
            id: toPublicId('refund', final.refunds[0]!.id),
            amount: '500.00',
            method: 'bank_transfer',
            reference: 'IBFT-778812',
            note: 'Stitching came apart',
            receipt: null,
            refundedAt: at,
          },
        ],
        calls: [],
        transferReceipts: [],
      },
      expect.objectContaining({
        name: `#${second.number}`,
        // Placed by staff, it came from no visit, and no browser.
        visits: null,
        browserIds: null,
        calls: [
          {
            calledAt: at,
            outcome: 'call_back',
            callBackAt: callBackAt.toISOString(),
            note: "At her sister's until Friday",
          },
        ],
        transferReceipts: [
          {
            id: toPublicId('transferReceipt', receipt),
            uploadedAt: at,
            contentType: 'image/jpeg',
            bytes: 48213,
          },
        ],
      }),
    ]);
    expect(file.draftOrders).toEqual([
      {
        id: toPublicId('draftOrder', draft.id),
        name: `#D${draft.number}`,
        createdAt: draft.createdAt.toISOString(),
        status: 'open',
        orderId: null,
        completedAt: null,
        paymentMethod: 'cash_on_delivery',
        currency: 'PKR',
        lineItems: [
          {
            title: 'Kurta',
            variantTitle: draft.lines[0]!.variantTitle,
            sku: null,
            quantity: 2,
            unitPrice: '1800.00',
            total: '3600.00',
          },
        ],
        subtotal: '3600.00',
        discount: '0.00',
        shipping: '0.00',
        total: '3600.00',
        advancePaid: '0.00',
        phone: '+923001234567',
        email: null,
        shippingAddress: expect.objectContaining({
          name: 'Ayesha Khan',
          city: 'Karachi',
        }) as object,
        note: '',
        tags: [],
      },
    ]);
    // Addresses read in the order they are written, whatever order Postgres keeps their keys in.
    const [first] = file.orders as { shippingAddress: object }[];
    expect(Object.keys(first!.shippingAddress)).toEqual([
      'name',
      'phone',
      'address1',
      'address2',
      'landmark',
      'city',
      'province',
      'zip',
      'latitude',
      'longitude',
    ]);
    // Their risk scores and the orders' timelines are the shop's, and stay out.
    const json = JSON.stringify(file);
    expect(json).not.toContain('"risk');
    expect(json).not.toContain('timeline');
  });
});
