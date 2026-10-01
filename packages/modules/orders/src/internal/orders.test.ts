import 'reflect-metadata';
import type { StaffRole, TenantContext } from '@hatti/api';
import { pgError } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toOrder } from './graphql/mappers.js';
import type { OrderCreateInput } from './order.service.js';
import { COD_CASH_LIMIT, codLimitError } from './rules.js';
import {
  bankTransferSettings,
  confirmationCalls,
  counters,
  draftOrders,
  fulfillmentLines,
  fulfillments,
  lines,
  orderComments,
  orderEvents,
  orderSettings,
  orders,
  refunds,
  riskSettings,
  transferReceipts,
} from './schema.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('OrderService', () => {
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

  it('matches the migrated tables', async () => {
    // Drizzle names every column, so a mismatch with the SQL migrations fails here.
    await f.db.tenant(f.a.shopId, async (tx) => {
      const tables = [
        counters,
        orders,
        lines,
        orderEvents,
        orderComments,
        fulfillments,
        fulfillmentLines,
        riskSettings,
        orderSettings,
        bankTransferSettings,
        confirmationCalls,
        refunds,
        draftOrders,
        transferReceipts,
      ];
      for (const table of tables) await tx.select().from(table).limit(0);
    });
  });

  it('places a cash-on-delivery order: numbered, priced from the catalog, stock committed', async () => {
    const [size8, size9] = await f.variantsOf(f.a, 'Peshawari Chappal', {
      sizes: ['8', '9'],
      price: '3,499',
    });
    await f.stock(f.a, size8!, 5);
    await f.stock(f.a, size9!, 5);
    await f.admin.query('DELETE FROM platform.outbox_events');

    const order = unwrap(
      await f.orders.create(f.a, {
        lineItems: [
          { variantId: size8!, quantity: 2 },
          { variantId: size9!, quantity: 1, price: '3,000' },
        ],
        shippingAddress: ADDRESS,
        email: ' ayesha@example.com ',
        shippingPrice: '250',
        discount: '499',
        note: 'Deliver after 5 pm',
        tags: ['whatsapp', 'WhatsApp', 'eid'],
      }),
    );
    expect(order).toMatchObject({
      number: 1001,
      source: 'api',
      status: 'open',
      confirmationStatus: 'pending',
      financialStatus: 'pending',
      fulfillmentStatus: 'unfulfilled',
      stage: 'needs_confirmation',
      paymentMethod: 'cash_on_delivery',
      currency: 'PKR',
      subtotal: 999_800n,
      discount: 49_900n,
      shipping: 25_000n,
      total: 974_900n,
      amountPaid: 0n,
      codAmount: 974_900n,
      phone: '+923001234567',
      email: 'ayesha@example.com',
      shippingAddress: {
        name: 'Ayesha Khan',
        phone: '+923001234567',
        address1: 'House 12, Street 4, Block 5',
        address2: 'Gulshan-e-Iqbal',
        landmark: 'Near Jamia Masjid',
        city: 'Karachi',
        provinceCode: 'SD',
        zip: '75300',
      },
      locationId: (await f.primary(f.a)).id,
      note: 'Deliver after 5 pm',
      tags: ['whatsapp', 'eid'],
      version: 1,
    });
    expect(order.lines).toMatchObject([
      {
        position: 1,
        variantId: size8,
        title: 'Peshawari Chappal',
        variantTitle: '8',
        sku: 'PES-8',
        quantity: 2,
        unitPrice: 349_900n,
        total: 699_800n,
      },
      { position: 2, variantId: size9, variantTitle: '9', unitPrice: 300_000n, total: 300_000n },
    ]);

    expect(await f.level(f.a, size8!)).toMatchObject({ onHand: 5, committed: 2, available: 3 });
    expect(await f.level(f.a, size9!)).toMatchObject({ committed: 1, available: 4 });
    const history = await f.inventory.history(f.a, size8!, { first: 1 });
    expect(history.items[0]).toMatchObject({
      reason: 'committed',
      referenceDocumentUri: `hatti://orders/${toPublicId('order', order.id)}`,
    });

    const timeline = await f.orders.timeline(f.a, order.id, { first: 10 });
    expect(timeline.items.map((entry) => [entry.kind, entry.message])).toEqual([
      ['created', 'Order #1001 placed through the API: Rs 9,749, cash on delivery'],
    ]);
    const events = await f.outbox();
    // The number is new, so its customer is too.
    expect(events.map((event) => event.event_type).sort()).toEqual([
      'customer.created',
      'inventory_level.updated',
      'inventory_level.updated',
      'order.created',
    ]);
    expect(events.find((event) => event.event_type === 'order.created')).toMatchObject({
      aggregate_id: order.id,
      payload: {
        number: 1001,
        customerId: order.customerId,
        source: 'api',
        paymentMethod: 'cash_on_delivery',
        total: '974900',
        currency: 'PKR',
        stage: 'needs_confirmation',
        version: 1,
      },
    });
  });

  it('numbers orders one after another, and a failed order uses no number', async () => {
    const [limited] = await f.variantsOf(f.a, 'Limited Khussa');
    const [untracked] = await f.variantsOf(f.a, 'Ajrak');
    await f.stock(f.a, limited!, 5);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.orders.create(f.a, {
          lineItems: [{ variantId: limited!, quantity: 1 }],
          shippingAddress: ADDRESS,
        }),
      ),
    );
    const placed = results.filter((result) => result.ok);
    expect(placed).toHaveLength(5);
    expect(
      placed.map((result) => (result.ok ? result.value.number : 0)).sort((x, y) => x - y),
    ).toEqual([1001, 1002, 1003, 1004, 1005]);
    expect(results.filter((result) => !result.ok).map(errorsOf)).toEqual(
      Array.from({ length: 3 }, () => [['input.lineItems.0.quantity', 'OUT_OF_STOCK']]),
    );
    expect((await f.order(f.a, [untracked!])).number).toBe(1006);
    // Each shop counts on its own.
    const [theirs] = await f.variantsOf(f.b, 'Theirs');
    expect((await f.order(f.b, [theirs!])).number).toBe(1001);
  });

  it('refuses an order it cannot fill, and changes nothing', async () => {
    const [lawn] = await f.variantsOf(f.a, 'Lawn Suit');
    await f.stock(f.a, lawn!, 1);
    const result = await f.orders.create(f.a, {
      lineItems: [{ variantId: lawn!, quantity: 3 }],
      shippingAddress: ADDRESS,
    });
    expect(errorsOf(result)).toEqual([['input.lineItems.0.quantity', 'OUT_OF_STOCK']]);
    expect(!result.ok && result.errors[0]!.message).toBe(
      'Only 1 of "Lawn Suit" left at Main location',
    );
    expect(await f.level(f.a, lawn!)).toMatchObject({ committed: 0, available: 1 });
    const { rows } = await f.admin.query('SELECT count(*)::int AS n FROM orders.orders');
    expect(rows[0].n).toBe(0);
  });

  it('takes prepaid orders and advance payments', async () => {
    const [shawl] = await f.variantsOf(f.a, 'Pashmina Shawl', { price: '12,500' });
    const prepaid = await f.order(f.a, [shawl!], { paymentMethod: 'prepaid' });
    expect(prepaid).toMatchObject({
      confirmationStatus: 'not_required',
      financialStatus: 'paid',
      stage: 'to_pack',
      amountPaid: 1_250_000n,
      codAmount: 0n,
    });
    expect(prepaid.paidAt).toBeInstanceOf(Date);

    const advance = await f.order(f.a, [shawl!], { advancePaid: '500', shippingPrice: '250' });
    expect(advance).toMatchObject({
      confirmationStatus: 'pending',
      financialStatus: 'partially_paid',
      total: 1_275_000n,
      amountPaid: 50_000n,
      codAmount: 1_225_000n,
      paidAt: null,
    });
    expect(
      errorsOf(
        await f.orders.create(f.a, {
          lineItems: [{ variantId: shawl!, quantity: 1 }],
          shippingAddress: ADDRESS,
          advancePaid: '20,000',
        }),
      ),
    ).toEqual([['input.advancePaid', 'INVALID']]);
    expect(
      errorsOf(
        await f.orders.create(f.a, {
          lineItems: [{ variantId: shawl!, quantity: 1 }],
          shippingAddress: ADDRESS,
          paymentMethod: 'prepaid',
          advancePaid: '100',
        }),
      ),
    ).toEqual([['input.advancePaid', 'INVALID']]);
  });

  it('collects no more cash on delivery than the law allows an order', async () => {
    const [lehnga] = await f.variantsOf(f.a, 'Bridal Lehnga', { price: '150,000' });
    const two = (extra: Partial<OrderCreateInput> = {}) =>
      f.orders.create(f.a, {
        lineItems: [{ variantId: lehnga!, quantity: 2 }],
        shippingAddress: ADDRESS,
        ...extra,
      });
    expect(await two()).toEqual({
      ok: false,
      errors: [
        {
          field: ['input', 'advancePaid'],
          code: 'COD_LIMIT',
          message:
            "Cash on delivery can't collect more than Rs 200,000 an order: take an advance of " +
            'at least Rs 100,000, or make it prepaid',
        },
      ],
    });
    // An advance that brings the cash to the limit will do, as will paying in full.
    expect(unwrap(await two({ advancePaid: '100,000' }))).toMatchObject({ codAmount: 200_000_00n });
    expect(unwrap(await two({ paymentMethod: 'prepaid' }))).toMatchObject({ codAmount: 0n });
    expect(errorsOf(await two({ advancePaid: '99,999' }))).toEqual([
      ['input.advancePaid', 'COD_LIMIT'],
    ]);
    // The law is Pakistan's: orders in other currencies are not bound by it.
    const order = { paymentMethod: 'cash_on_delivery' as const, advance: 0n };
    expect(codLimitError([], { ...order, currency: 'PKR', total: COD_CASH_LIMIT })).toBeNull();
    expect(codLimitError([], { ...order, currency: 'PKR', total: COD_CASH_LIMIT + 1n })).toEqual(
      expect.objectContaining({ code: 'COD_LIMIT' }),
    );
    expect(codLimitError([], { ...order, currency: 'USD', total: 10n ** 12n })).toBeNull();
  });

  it("says what waits for the shop, as the admin's home shows it", async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta', { price: '2,000' });
    await f.stock(f.a, kurta!, 50);
    const none = { count: 0, total: 0n };
    expect(await f.orders.home(f.a)).toEqual({
      toConfirm: none,
      toReview: none,
      awaitingPayment: none,
      transfersToCheck: none,
      toPack: none,
      toBook: none,
      returning: none,
      lostToClaim: none,
      claimsOpen: none,
      cashToCollect: none,
    });

    const placed = () => f.order(f.a, [kurta!]);
    const confirmed = async () => unwrap(await f.orders.confirm(f.a, (await placed()).id));
    const shipped = async (order: { id: string }) =>
      unwrap(await f.fulfillments.fulfill(f.a, order.id, {})).fulfillmentId;
    await placed();
    await placed();
    await confirmed();
    unwrap(await f.orders.markPacked(f.a, (await confirmed()).id));
    await shipped(await confirmed());
    const delivered = await shipped(await confirmed());
    unwrap(await f.fulfillments.markDelivered(f.a, delivered));
    // Delivered and paid: nothing waits.
    const done = await confirmed();
    unwrap(await f.fulfillments.markDelivered(f.a, await shipped(done)));
    unwrap(await f.orders.markAsPaid(f.a, done.id));
    unwrap(await f.fulfillments.markReturning(f.a, await shipped(await confirmed())));
    // Prepaid: nothing to collect; an advance: the rest.
    await shipped(await f.order(f.a, [kurta!], { paymentMethod: 'prepaid' }));
    await shipped(
      unwrap(
        await f.orders.confirm(f.a, (await f.order(f.a, [kurta!], { advancePaid: '500' })).id),
      ),
    );
    // A blocked number's order waits for staff.
    unwrap(await f.blocklist.add(f.a, { phone: '03217654321', reason: 'fake_orders' }));
    await f.order(f.a, [kurta!], { shippingAddress: { ...ADDRESS, phone: '03217654321' } });
    // A bank transfer waits for its money: nothing to collect at the door.
    await f.order(f.a, [kurta!], { paymentMethod: 'bank_transfer' });

    expect(await f.orders.home(f.a)).toEqual({
      toConfirm: { count: 2, total: 4_000_00n },
      toReview: { count: 1, total: 2_000_00n },
      awaitingPayment: { count: 1, total: 2_000_00n },
      // It has no receipt yet: nothing to check.
      transfersToCheck: none,
      toPack: { count: 1, total: 2_000_00n },
      toBook: { count: 1, total: 2_000_00n },
      returning: { count: 1, total: 2_000_00n },
      // Lost parcels are counted apart (fulfillments.test.ts).
      lostToClaim: none,
      claimsOpen: none,
      // In transit, delivered not yet paid, and the rest of an advance.
      cashToCollect: { count: 3, total: 5_500_00n },
    });
    expect((await f.orders.home(f.b)).toConfirm).toEqual(none);
  });

  it('checks the input', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const create = (extra: Record<string, unknown>) =>
      f.orders.create(f.a, {
        lineItems: [{ variantId: kurta!, quantity: 1 }],
        shippingAddress: ADDRESS,
        ...extra,
      });
    expect(
      errorsOf(
        await create({
          lineItems: [
            { variantId: kurta!, quantity: 0 },
            { variantId: kurta!, quantity: 1, price: 'free' },
          ],
          shippingAddress: {
            name: ' ',
            phone: '042-35761234',
            address1: 'House 1',
            city: 'Lahore',
            province: 'Texas',
            zip: '5400',
          },
          email: 'not-an-email',
          shippingPrice: '-1',
        }),
      ),
    ).toEqual([
      ['input.lineItems.0.quantity', 'INVALID'],
      ['input.lineItems.1.price', 'INVALID'],
      ['input.shippingAddress.name', 'BLANK'],
      ['input.shippingAddress.phone', 'INVALID'],
      ['input.shippingAddress.province', 'INVALID'],
      ['input.shippingAddress.zip', 'INVALID'],
      ['input.email', 'INVALID'],
      ['input.shippingPrice', 'INVALID'],
    ]);
    expect(errorsOf(await create({ lineItems: [] }))).toEqual([['input.lineItems', 'BLANK']]);
    expect(errorsOf(await create({ discount: '5,000' }))).toEqual([['input.discount', 'INVALID']]);

    const [archived] = await f.variantsOf(f.a, 'Old Stock');
    const product = await f.admin.query(
      `UPDATE catalog.products SET status = 'archived' WHERE title = 'Old Stock' RETURNING id`,
    );
    expect(product.rowCount).toBe(1);
    await f.primary(f.a);
    const closed = await f.locations.add(f.a, { name: 'Closed store' });
    unwrap(await f.locations.deactivate(f.a, unwrap(closed).id));
    expect(
      errorsOf(
        await create({
          lineItems: [
            { variantId: newId(), quantity: 1 },
            { variantId: archived!, quantity: 1 },
          ],
          locationId: unwrap(closed).id,
        }),
      ),
    ).toEqual([
      ['input.locationId', 'INVALID'],
      ['input.lineItems.0.variantId', 'NOT_FOUND'],
      ['input.lineItems.1.variantId', 'INVALID'],
    ]);
    expect(errorsOf(await create({ locationId: newId() }))).toEqual([
      ['input.locationId', 'NOT_FOUND'],
    ]);
  });

  it('confirms cash-on-delivery orders', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const order = await f.order(f.a, [kurta!]);
    const confirmed = unwrap(await f.orders.confirm(f.a, order.id));
    expect(confirmed).toMatchObject({
      confirmationStatus: 'confirmed',
      stage: 'to_pack',
      version: 2,
    });
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    // Confirming again changes nothing.
    expect(unwrap(await f.orders.confirm(f.a, order.id)).version).toBe(2);
    const prepaid = await f.order(f.a, [kurta!], { paymentMethod: 'prepaid' });
    expect(unwrap(await f.orders.confirm(f.a, prepaid.id)).confirmationStatus).toBe('not_required');
    expect(errorsOf(await f.orders.confirm(f.a, newId()))).toEqual([['id', 'NOT_FOUND']]);

    const events = (await f.outbox()).filter((event) => event.event_type === 'order.confirmed');
    expect(events).toEqual([
      expect.objectContaining({
        aggregate_id: order.id,
        payload: { stage: 'to_pack', version: 2 },
      }),
    ]);
  });

  it('cancels an order and gives its stock back', async () => {
    const [chappal] = await f.variantsOf(f.a, 'Chappal');
    await f.stock(f.a, chappal!, 4);
    const order = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: chappal!, quantity: 3 }],
        shippingAddress: ADDRESS,
      }),
    );
    expect(await f.level(f.a, chappal!)).toMatchObject({ committed: 3, available: 1 });

    const cancelled = unwrap(
      await f.orders.cancel(f.a, order.id, { reason: 'no_response', staffNote: 'Called 3 times' }),
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
      cancelReason: 'no_response',
      version: 2,
    });
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(await f.level(f.a, chappal!)).toMatchObject({ committed: 0, available: 4 });
    const history = await f.inventory.history(f.a, chappal!, { first: 1 });
    expect(history.items[0]).toMatchObject({ reason: 'commitment_released', delta: -3 });

    // Cancelling again changes nothing; a cancelled order cannot be confirmed or paid.
    expect(unwrap(await f.orders.cancel(f.a, order.id, { reason: 'other' })).version).toBe(2);
    expect(errorsOf(await f.orders.confirm(f.a, order.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.orders.markAsPaid(f.a, order.id))).toEqual([['id', 'INVALID']]);

    const timeline = await f.orders.timeline(f.a, order.id, { first: 1 });
    expect(timeline.items[0]).toMatchObject({
      kind: 'cancelled',
      message: 'Cancelled because the customer could not be reached: Called 3 times',
    });
    expect(
      (await f.outbox()).find((event) => event.event_type === 'order.cancelled')?.payload,
    ).toEqual({ reason: 'no_response', stage: 'cancelled', version: 2 });
  });

  it('changes the address, email, note and tags', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const order = await f.order(f.a, [kurta!]);
    const updated = unwrap(
      await f.orders.update(f.a, order.id, {
        shippingAddress: { ...ADDRESS, phone: '+92 321 7654321', city: 'lhr', zip: null },
        note: 'Call before delivery',
        tags: ['vip'],
      }),
    );
    expect(updated).toMatchObject({
      phone: '+923217654321',
      shippingAddress: { city: 'Lahore', provinceCode: 'PB', zip: null },
      note: 'Call before delivery',
      tags: ['vip'],
      version: 2,
    });
    // The same values again: nothing to change.
    expect(
      unwrap(await f.orders.update(f.a, order.id, { note: 'Call before delivery' })).version,
    ).toBe(2);
    expect(unwrap(await f.orders.update(f.a, order.id, { email: 'x@example.com' })).email).toBe(
      'x@example.com',
    );
    expect(unwrap(await f.orders.update(f.a, order.id, { email: null })).email).toBeNull();

    const timeline = await f.orders.timeline(f.a, order.id, { first: 10 });
    expect(timeline.items.map((entry) => entry.message)).toEqual([
      'Changed the email',
      'Changed the email',
      // A new number makes it the order of that number's customer.
      'Changed the shipping address, note, tags, customer',
      'Order #1001 placed through the API: Rs 1,000, cash on delivery',
    ]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'order.updated')
        .map((event) => event.payload.changed),
    ).toEqual([['shippingAddress', 'note', 'tags', 'customer'], ['email'], ['email']]);

    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    expect(errorsOf(await f.orders.update(f.a, order.id, { shippingAddress: ADDRESS }))).toEqual([
      ['input.shippingAddress', 'INVALID'],
    ]);
    expect(
      unwrap(await f.orders.update(f.a, order.id, { note: 'Refused on the phone' })).note,
    ).toBe('Refused on the phone');
  });

  it('records payment', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta', { price: '2,000' });
    const order = await f.order(f.a, [kurta!], { advancePaid: '500' });
    const paid = unwrap(await f.orders.markAsPaid(f.a, order.id));
    expect(paid).toMatchObject({ financialStatus: 'paid', amountPaid: 200_000n, version: 2 });
    expect(paid.paidAt).toBeInstanceOf(Date);
    expect(unwrap(await f.orders.markAsPaid(f.a, order.id)).version).toBe(2);
    const timeline = await f.orders.timeline(f.a, order.id, { first: 1 });
    expect(timeline.items[0]!.message).toBe('Marked as paid: Rs 1,500 received');
  });

  it('finds orders by number, mobile number and name, and counts them by stage', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const first = await f.order(f.a, [kurta!]);
    const second = await f.order(f.a, [kurta!], {
      shippingAddress: { ...ADDRESS, name: 'Bilal Ahmed', phone: '03217654321', city: 'Multan' },
      paymentMethod: 'prepaid',
    });
    const third = await f.order(f.a, [kurta!], {
      shippingAddress: { ...ADDRESS, name: 'Ayesha Siddiqui' },
    });
    unwrap(await f.orders.cancel(f.a, third.id, { reason: 'customer' }));

    const numbers = async (query: string | null, extra: Record<string, unknown> = {}) =>
      (await f.orders.list(f.a, { first: 10, query, ...extra })).items.map((order) => order.number);
    expect(await numbers(null)).toEqual([1003, 1002, 1001]);
    expect(await numbers('#1002')).toEqual([1002]);
    expect(await numbers('1001')).toEqual([1001]);
    expect(await numbers('+92 321 765 4321')).toEqual([1002]);
    expect(await numbers('ayesha')).toEqual([1003, 1001]);
    expect(await numbers('multan')).toEqual([1002]);
    expect(await numbers(null, { stage: 'needs_confirmation' })).toEqual([1001]);
    const page = await f.orders.list(f.a, { first: 2 });
    expect(page.hasNextPage).toBe(true);
    expect(
      (await f.orders.list(f.a, { first: 2, after: page.items[1]!.id })).items.map(
        (order) => order.id,
      ),
    ).toEqual([first.id]);

    const counts = await f.orders.stageCounts(f.a);
    expect(Object.fromEntries([...counts].filter(([, count]) => count > 0))).toEqual({
      needs_confirmation: 1,
      to_pack: 1,
      cancelled: 1,
    });
    expect(second.stage).toBe('to_pack');
  });

  it("filters orders as Shopify's search syntax writes it, among the words", async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const waiting = await f.order(f.a, [kurta!], { tags: ['VIP', 'Gift wrap'] });
    const prepaid = await f.order(f.a, [kurta!], {
      shippingAddress: { ...ADDRESS, name: 'Bilal Ahmed', phone: '03217654321', city: 'Multan' },
      paymentMethod: 'prepaid',
      tags: ['vip'],
    });
    const cancelled = await f.order(f.a, [kurta!], {
      shippingAddress: { ...ADDRESS, name: 'Ayesha Siddiqui' },
    });
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const numbers = async (query: string) =>
      (await f.orders.list(f.a, { first: 10, query })).items.map((order) => order.number);

    expect(await numbers('stage:to_pack')).toEqual([prepaid.number]);
    expect(await numbers('status:cancelled')).toEqual([cancelled.number]);
    expect(await numbers('payment_method:cash_on_delivery')).toEqual([
      cancelled.number,
      waiting.number,
    ]);
    // Tags in any letter case; a minus for the orders a filter does not match.
    expect(await numbers('tag:vip')).toEqual([prepaid.number, waiting.number]);
    expect(await numbers('tag:"gift WRAP"')).toEqual([waiting.number]);
    expect(await numbers('-tag:vip')).toEqual([cancelled.number]);
    // Orders without a risk score are not at any level, so none of them is left out by one.
    expect(await numbers('-risk_level:high')).toEqual([
      cancelled.number,
      prepaid.number,
      waiting.number,
    ]);
    // Filters with words, and filters together, all of which hold.
    expect(await numbers('ayesha -status:cancelled')).toEqual([waiting.number]);
    expect(await numbers('source:api tag:vip financial_status:paid')).toEqual([prepaid.number]);
    expect(await numbers('has_transfer_receipt:false fulfillment_status:unfulfilled')).toEqual([
      cancelled.number,
      prepaid.number,
      waiting.number,
    ]);
    // The export filters as the list does, and refuses what the list refuses.
    const exported = unwrap(
      await f.exports.export(f.a, { query: 'tag:vip -stage:to_pack', layout: 'orders' }),
    );
    expect(exported.rowCount).toBe(1);
    expect(
      errorsOf(await f.exports.export(f.a, { query: 'stage:packed', layout: 'orders' })),
    ).toEqual([['query', 'INVALID']]);
  });

  it('gives orders to members of staff, who find theirs with assignee:me', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const order = await f.order(f.a, [kurta!]);
    const other = await f.order(f.a, [kurta!]);
    const staff = (role: StaffRole, userId: string): TenantContext => ({
      ...f.a,
      actor: { kind: 'staff', userId, sessionId: newId(), authenticatedAt: new Date(), role },
    });
    const [ayeshaId, bilalId] = [newId(), newId()];
    const ayesha = staff('confirmation_agent', ayeshaId);
    const bilal = staff('packer', bilalId);
    const toAyesha = { staffMemberId: ayeshaId, name: 'Ayesha Khan' };
    const toBilal = { staffMemberId: bilalId, name: 'Bilal Ahmed' };

    // Owners, managers and apps give an order to anyone; to the same member again, nothing new.
    const assigned = unwrap(await f.orders.assign(f.a, order.id, toAyesha, { fromOthers: true }));
    expect(assigned).toMatchObject({
      assignee: { staffMemberId: ayeshaId, assignedAt: expect.any(Date) },
      version: 2,
    });
    expect(toOrder(assigned, f.a)).toMatchObject({ assigneeId: ayeshaId });
    expect(
      unwrap(await f.orders.assign(f.a, order.id, toAyesha, { fromOthers: true })).version,
    ).toBe(2);

    const numbers = async (tenant: TenantContext, query: string) =>
      (await f.orders.list(tenant, { first: 10, query })).items.map((each) => each.number);
    expect(await numbers(ayesha, 'assignee:me')).toEqual([order.number]);
    expect(await numbers(bilal, 'assignee:me')).toEqual([]);
    // An app is no member of staff: none of the orders is its own.
    expect(await numbers(f.a, 'assignee:me')).toEqual([]);
    expect(await numbers(f.a, `assignee:${toPublicId('user', ayeshaId)}`)).toEqual([order.number]);
    expect(await numbers(f.a, 'assignee:none')).toEqual([other.number]);
    expect(await numbers(ayesha, '-assignee:me')).toEqual([other.number]);

    // Other staff take an order no one has, and give back their own, but not someone else's.
    expect(
      errorsOf(await f.orders.assign(bilal, order.id, toBilal, { fromOthers: false })),
    ).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.orders.assign(bilal, order.id, null, { fromOthers: false }))).toEqual([
      ['id', 'INVALID'],
    ]);
    unwrap(await f.orders.assign(bilal, other.id, toBilal, { fromOthers: false }));
    expect(
      unwrap(await f.orders.assign(ayesha, order.id, null, { fromOthers: false })).assignee,
    ).toBeNull();

    const timeline = await f.orders.timeline(f.a, order.id, { first: 10 });
    expect(timeline.items.map((entry) => entry.message)).toEqual([
      'No longer assigned to anyone',
      'Assigned to Ayesha Khan',
      'Order #1001 placed through the API: Rs 1,000, cash on delivery',
    ]);
    expect(timeline.items.map((entry) => entry.kind).slice(0, 2)).toEqual([
      'unassigned',
      'assigned',
    ]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'order.updated')
        .map((event) => [event.aggregate_id, event.payload.changed]),
    ).toEqual([
      [order.id, ['assignee']],
      [other.id, ['assignee']],
      [order.id, ['assignee']],
    ]);

    // A member who leaves gives back their open orders; the ended keep whom they were given to.
    unwrap(await f.orders.assign(f.a, order.id, toBilal, { fromOthers: true }));
    const cancelled = await f.order(f.a, [kurta!]);
    unwrap(await f.orders.assign(f.a, cancelled.id, toBilal, { fromOthers: true }));
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    expect(await f.orders.release(f.a, bilalId)).toBe(2);
    expect(await numbers(f.a, `assignee:${toPublicId('user', bilalId)}`)).toEqual([
      cancelled.number,
    ]);
    expect((await f.orders.timeline(f.a, other.id, { first: 1 })).items[0]!.message).toBe(
      'No longer assigned to anyone: its assignee left the shop',
    );
    expect(await f.orders.release(f.a, bilalId)).toBe(0);
  });

  it('masks customers’ numbers for everyone but owners, managers and apps', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    // Placed through checkout: where it came from is theirs to see, as the number is.
    const order = {
      ...(await f.order(f.a, [kurta!])),
      agreement: {
        policyVersions: [],
        agreedAt: new Date(),
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      },
    };
    const staff = (role: StaffRole): TenantContext => ({
      ...f.a,
      actor: {
        kind: 'staff',
        userId: newId(),
        sessionId: newId(),
        authenticatedAt: new Date(),
        role,
      },
    });
    for (const role of ['packer', 'confirmation_agent', 'marketer', 'accountant'] as const) {
      expect(toOrder(order, staff(role)), role).toMatchObject({
        phone: '0300 ••••567',
        shippingAddress: { phone: '0300 ••••567' },
        agreement: { ip: null, userAgent: null },
      });
    }
    const manager = staff('manager');
    expect(toOrder(order, f.a).phone).toBe('+923001234567');
    expect(toOrder(order, manager).phone).toBe('+923001234567');
    expect(toOrder(order, manager).agreement).toMatchObject({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(toOrder(order, manager).shippingAddress.formatted).toEqual([
      'Ayesha Khan',
      'House 12, Street 4, Block 5',
      'Gulshan-e-Iqbal',
      'Near Jamia Masjid',
      'Karachi 75300',
      'Sindh',
    ]);
  });

  it("reveals an order's number, and logs who saw it", async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const order = await f.order(f.a, [kurta!]);
    await f.admin.query('DELETE FROM platform.audit_log');
    const agent: TenantContext = {
      ...f.a,
      actor: {
        kind: 'staff',
        userId: newId(),
        sessionId: newId(),
        authenticatedAt: new Date(),
        role: 'confirmation_agent',
      },
    };
    expect(unwrap(await f.orders.revealPhone(agent, order.id))).toBe('+923001234567');
    const log = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 5 }));
    expect(log.items).toMatchObject([
      {
        action: 'order.phone_revealed',
        subjectType: 'order',
        subjectId: order.id,
        actorRole: 'confirmation_agent',
        details: { number: order.number },
      },
    ]);
    expect(errorsOf(await f.orders.revealPhone(f.b, order.id))).toEqual([['id', 'NOT_FOUND']]);
  });

  it('keeps the timeline append-only for request code', async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    await f.order(f.a, [kurta!]);
    for (const statement of [
      'UPDATE orders.order_events SET message = $$edited$$',
      'DELETE FROM orders.order_events',
    ]) {
      const error = await f.db
        .tenant(f.a.shopId, (tx) => tx.execute(sql.raw(statement)))
        .catch((caught: unknown) => caught);
      expect([statement, pgError(error)?.code]).toEqual([statement, '42501']);
    }
  });

  it("keeps each shop's orders to itself", async () => {
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    const order = await f.order(f.a, [kurta!]);
    const primaryA = await f.primary(f.a);

    expect(await f.orders.get(f.b, order.id)).toBeNull();
    expect((await f.orders.list(f.b, { first: 10 })).items).toEqual([]);
    expect((await f.orders.timeline(f.b, order.id, { first: 10 })).items).toEqual([]);
    for (const attempt of [
      () => f.orders.confirm(f.b, order.id),
      () => f.orders.cancel(f.b, order.id, { reason: 'fraud' }),
      () => f.orders.markAsPaid(f.b, order.id),
      () => f.orders.update(f.b, order.id, { note: 'Mine now' }),
    ]) {
      expect(errorsOf(await attempt())).toEqual([['id', 'NOT_FOUND']]);
    }
    // B cannot sell A's products, or ship from A's location.
    expect(
      errorsOf(
        await f.orders.create(f.b, {
          lineItems: [{ variantId: kurta!, quantity: 1 }],
          shippingAddress: ADDRESS,
          locationId: primaryA.id,
        }),
      ),
    ).toEqual([
      ['input.locationId', 'NOT_FOUND'],
      ['input.lineItems.0.variantId', 'NOT_FOUND'],
    ]);
    expect(unwrap(await f.orders.confirm(f.a, order.id)).confirmationStatus).toBe('confirmed');
  });
});
