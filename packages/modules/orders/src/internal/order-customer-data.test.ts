import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfirmationDeskService } from './confirmation-desk.service.js';
import { toOrder } from './graphql/mappers.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

const SECOND_SIM = { ...ADDRESS, phone: '0311 1234567' };

describe.skipIf(!server)('Orders when customers merge or are erased', () => {
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
    });
    // Placed through checkout, it keeps what she agreed to, and where she placed it from.
    const version = '01a0f3b1-9685-7065-988d-604298214e34';
    await f.admin.query(
      `UPDATE orders.orders
          SET agreed_policy_versions = ARRAY[$2::uuid], client_ip = '203.0.113.7',
              client_user_agent = 'Mozilla/5.0 (Linux; Android 14)'
        WHERE id = $1`,
      [completed.id, version],
    );
    unwrap(await f.fulfillments.markDelivered(f.a, await ship(completed.id)));
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

    const erased = (await f.orders.get(f.a, completed.id))!;
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
      agreement: { policyVersions: [version], ip: null, userAgent: null },
      // The rest stays, for the accounts.
      number: completed.number,
      total: 200_000n,
      amountPaid: 200_000n,
      stage: 'completed',
      lines: [{ title: 'Kurta', quantity: 1 }],
    });
    expect(erased.customerErasedAt).toBeInstanceOf(Date);
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
});
