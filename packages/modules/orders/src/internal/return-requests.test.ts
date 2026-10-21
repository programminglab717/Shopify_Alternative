import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrderLinkView } from './order-link.service.js';
import type { OrderRecord } from './records.js';
import { ReturnRequestService, type ReturnRequestForm } from './return-request.service.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Returns shoppers ask for (ADR-675)', () => {
  let f: OrdersFixture;
  let requests: ReturnRequestService;
  let chappal: string;
  let khussa: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    requests = new ReturnRequestService(f.db, f.returns);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [chappal] = (await f.variantsOf(f.a, 'Peshawari Chappal', { price: '3,499' })) as [string];
    [khussa] = (await f.variantsOf(f.a, 'Multani Khussa', { price: '2,250' })) as [string];
    await f.stock(f.a, chappal, 5);
    await f.stock(f.a, khussa, 5);
  });

  /** An order for 2 chappals and 1 khussa, delivered, with its customer's link's secret. */
  async function delivered(): Promise<{ order: OrderRecord; token: string }> {
    const placed = unwrap(
      await f.orders.create(f.a, {
        lineItems: [
          { variantId: chappal, quantity: 2 },
          { variantId: khussa, quantity: 1 },
        ],
        shippingAddress: ADDRESS,
      }),
    );
    unwrap(await f.orders.confirm(f.a, placed.id));
    const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, placed.id, {}));
    const { order } = unwrap(await f.fulfillments.markDelivered(f.a, fulfillmentId));
    const url = unwrap(await f.links.createLink(f.a, order.id)).url;
    return { order, token: url.slice('https://hatti.test/o/'.length) };
  }

  const lineOf = (order: OrderRecord, variantId: string) =>
    order.lines.find((line) => line.variantId === variantId)!;

  /** A form asking to send back `lines`, by line ID: how many, and why. */
  const formOf = (
    lines: Record<string, [string, string]>,
    preference = 'exchange',
    note = '',
  ): ReturnRequestForm => ({
    lines: new Map(
      Object.entries(lines).map(([id, [quantity, reason]]) => [id, { quantity, reason }]),
    ),
    preference,
    note,
  });

  const asOrder = (view: OrderLinkView) => {
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    return view;
  };

  it('takes a return from the order’s page within the shop’s days, one waiting at a time', async () => {
    const { order, token } = await delivered();
    const chappalLine = lineOf(order, chappal).id;
    const khussaLine = lineOf(order, khussa).id;
    // The shop takes none online: the page offers nothing, and asking is too late.
    expect(asOrder(await f.links.viewLink(token)).returns).toBeNull();
    expect(
      asOrder(
        await f.links.requestReturn(token, formOf({ [chappalLine]: ['1', 'size_too_small'] })),
      ).problem,
    ).toEqual({ kind: 'too_late', action: 'return' });

    expect(
      errorsOf(await f.orderSettings.update(f.a, { returnWindowDays: 31 })).map(([field]) => field),
    ).toEqual(['input.returnWindowDays']);
    unwrap(await f.orderSettings.update(f.a, { returnWindowDays: 7 }));
    const offered = asOrder(await f.links.viewLink(token)).returns!;
    expect(offered.until!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(offered.lines.map((line) => [line.lineItemId, line.units])).toEqual([
      [chappalLine, 2],
      [khussaLine, 1],
    ]);
    expect(offered.latest).toBeNull();

    // Nothing chosen, an item without its reason, no choice of what they would like.
    const problemOf = async (form: ReturnRequestForm) =>
      asOrder(await f.links.requestReturn(token, form)).problem;
    expect(await problemOf(formOf({ [chappalLine]: ['0', 'size_too_small'] }))).toEqual({
      kind: 'return',
      reason: 'none',
    });
    expect(await problemOf(formOf({ [chappalLine]: ['1', ''] }))).toEqual({
      kind: 'return',
      reason: 'reason',
    });
    expect(await problemOf(formOf({ [chappalLine]: ['1', 'size_too_small'] }, 'cash'))).toEqual({
      kind: 'return',
      reason: 'preference',
    });

    // More than came is as many as came.
    const asked = asOrder(
      await f.links.requestReturn(
        token,
        formOf(
          { [chappalLine]: ['5', 'size_too_small'], [khussaLine]: ['0', ''] },
          'exchange',
          '  Size 9 please  ',
        ),
      ),
    );
    expect(asked.problem).toBeNull();
    expect(asked.returns).toMatchObject({
      lines: [],
      latest: {
        status: 'requested',
        preference: 'exchange',
        note: 'Size 9 please',
        lines: [{ lineItemId: chappalLine, quantity: 2, reason: 'size_too_small' }],
      },
    });
    expect(await problemOf(formOf({ [khussaLine]: ['1', 'defective'] }, 'refund'))).toEqual({
      kind: 'return',
      reason: 'waiting',
    });
    expect(
      (await f.orders.timeline(f.a, order.id, { first: 50 })).items.map((entry) => entry.message),
    ).toContain(
      'The customer asked to return 2 × Peshawari Chappal, too small, for another size or ' +
        'item: "Size 9 please"',
    );
  });

  it('becomes a return once staff approve it, or is declined saying why', async () => {
    unwrap(await f.orderSettings.update(f.a, { returnWindowDays: 7 }));
    const { order, token } = await delivered();
    const chappalLine = lineOf(order, chappal).id;
    const khussaLine = lineOf(order, khussa).id;
    asOrder(
      await f.links.requestReturn(token, formOf({ [khussaLine]: ['1', 'defective'] }, 'refund')),
    );
    const [waiting] = (await requests.list(f.a, { status: 'requested', first: 10 })).items;
    expect(waiting).toMatchObject({ orderNumber: order.number, preference: 'refund' });

    // Declining says why.
    expect(errorsOf(await requests.decline(f.a, waiting!.id, '  '))).toEqual([['reason', 'BLANK']]);
    const { request: declined } = unwrap(
      await requests.decline(f.a, waiting!.id, 'Worn shoes are not taken back'),
    );
    expect(declined).toMatchObject({
      status: 'declined',
      declineReason: 'Worn shoes are not taken back',
    });
    expect(errorsOf(await requests.approve(f.a, waiting!.id))).toEqual([['id', 'INVALID']]);
    // The page says so; the shopper may ask again while the days last.
    expect(asOrder(await f.links.viewLink(token)).returns).toMatchObject({
      latest: { status: 'declined', declineReason: 'Worn shoes are not taken back' },
      lines: [
        { lineItemId: chappalLine, units: 2 },
        { lineItemId: khussaLine, units: 1 },
      ],
    });

    asOrder(
      await f.links.requestReturn(
        token,
        formOf({ [chappalLine]: ['1', 'size_too_large'] }, 'store_credit'),
      ),
    );
    const [again] = (await requests.list(f.a, { status: 'requested', first: 10 })).items;
    const approved = unwrap(await requests.approve(f.a, again!.id));
    expect(approved.request).toMatchObject({ status: 'approved', returnId: approved.return.id });
    expect(approved.return).toMatchObject({
      status: 'open',
      note: 'Asked by the customer, for store credit',
      lines: [{ lineId: chappalLine, quantity: 1, reason: 'size_too_large' }],
    });
    // What came back is no longer offered; one chappal and the khussa still are.
    expect(asOrder(await f.links.viewLink(token)).returns!.lines).toEqual([
      expect.objectContaining({ lineItemId: chappalLine, units: 1 }),
      expect.objectContaining({ lineItemId: khussaLine, units: 1 }),
    ]);
    expect((await requests.list(f.a, { orderId: order.id, first: 10 })).items).toHaveLength(2);
    const timeline = (await f.orders.timeline(f.a, order.id, { first: 50 })).items.map(
      (entry) => entry.message,
    );
    expect(timeline).toEqual(
      expect.arrayContaining([
        "Declined the customer's return request: Worn shoes are not taken back",
        `Approved the customer's return request, as #${order.number}-R1`,
      ]),
    );
  });
});
