import 'reflect-metadata';
import { InputChecker, type StaffRole, type TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { TaxSettingsService } from '@hatti/tax/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkAddress } from './address.js';
import { CodHealthService } from './cod-health.service.js';
import { orderLinkPage } from './link-pages.js';
import type { OrderRecord } from './records.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Editing an order's items", () => {
  let f: OrdersFixture;
  let kurta: string;
  let dupatta: string;
  let chappal: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,360' })) as [string];
    [dupatta] = (await f.variantsOf(f.a, 'Dupatta')) as [string];
    [, chappal] = (await f.variantsOf(f.a, 'Chappal', { sizes: ['7', '8'], price: '3,000' })) as [
      string,
      string,
    ];
    for (const variant of [kurta, dupatta, chappal]) await f.stock(f.a, variant, 10);
  });

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
  const lineOf = (order: OrderRecord, variantId: string) =>
    order.lines.find((line) => line.variantId === variantId)!;

  it('changes quantities, takes items off and adds others, its stock and totals following', async () => {
    unwrap(await new TaxSettingsService(f.db).update(f.a, { rate: 18 }));
    const order = await f.order(f.a, [kurta, dupatta], { shippingPrice: '250' });
    expect(order).toMatchObject({ total: 3_610_00n, codAmount: 3_610_00n, totalTax: 512_54n });
    // The shop's price changes since; the kurtas on the order keep theirs.
    await f.admin.query('UPDATE catalog.variants SET price = 250000 WHERE id = $1', [kurta]);
    const agent = staff('confirmation_agent');

    const edited = unwrap(
      await f.edits.editLineItems(agent, order.id, {
        setQuantities: [
          { lineItemId: lineOf(order, kurta).id, quantity: 2 },
          { lineItemId: lineOf(order, dupatta).id, quantity: 0 },
        ],
        addVariants: [{ variantId: chappal, quantity: 1 }],
      }),
    );
    expect(
      edited.lines.map((line) => [
        line.id,
        line.position,
        line.title,
        line.variantTitle,
        line.quantity,
        line.unitPrice,
        line.total,
        line.taxRate,
        line.tax,
      ]),
    ).toEqual([
      [
        lineOf(order, kurta).id,
        1,
        'Kurta',
        'Default Title',
        2,
        2_360_00n,
        4_720_00n,
        18_00,
        720_00n,
      ],
      [expect.any(String), 2, 'Chappal', '8', 1, 3_000_00n, 3_000_00n, 18_00, 457_63n],
    ]);
    expect(edited).toMatchObject({
      subtotal: 7_720_00n,
      shipping: 250_00n,
      total: 7_970_00n,
      codAmount: 7_970_00n,
      totalTax: 1_177_63n,
      financialStatus: 'pending',
      stage: 'needs_confirmation',
      version: order.version + 1,
    });

    // Its stock: the second kurta and the chappal committed, the dupatta let go.
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 2, available: 8 });
    expect(await f.level(f.a, dupatta)).toMatchObject({ committed: 0, available: 10 });
    expect(await f.level(f.a, chappal)).toMatchObject({ committed: 1, available: 9 });
    const history = await f.inventory.history(f.a, dupatta, { first: 1 });
    expect(history.items[0]).toMatchObject({
      reason: 'commitment_released',
      delta: -1,
      referenceDocumentUri: `hatti://orders/${toPublicId('order', order.id)}`,
    });

    const timeline = await f.orders.timeline(f.a, order.id, { first: 1 });
    expect(timeline.items[0]).toMatchObject({
      kind: 'edited',
      message:
        'Changed the items: 2 × Kurta instead of 1, removed Dupatta, added 1 × Chappal (8); ' +
        'Rs 7,970 instead of Rs 3,610',
      actorKind: 'staff',
    });
    const events = (await f.outbox()).filter((event) => event.event_type === 'order.updated');
    expect(events.map((event) => event.payload.changed)).toEqual([['lineItems']]);

    // An edit that changes nothing leaves it as it is.
    const same = unwrap(
      await f.edits.editLineItems(agent, order.id, {
        setQuantities: [{ lineItemId: lineOf(order, kurta).id, quantity: 2 }],
      }),
    );
    expect(same.version).toBe(edited.version);
    // Taking one back off: the same total as at first but for the chappal, and no "more".
    const back = unwrap(
      await f.edits.editLineItems(agent, order.id, {
        setQuantities: [{ lineItemId: lineOf(order, kurta).id, quantity: 1 }],
      }),
    );
    expect(back).toMatchObject({ subtotal: 5_360_00n, total: 5_610_00n });
    expect(back.lines.map((line) => line.position)).toEqual([1, 2]);
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 1, available: 9 });
  });

  it('refuses what it cannot do, and leaves the order as it was', async () => {
    const order = await f.order(f.a, [kurta, dupatta]);
    const kurtaLine = lineOf(order, kurta).id;
    const dupattaLine = lineOf(order, dupatta).id;
    const edit = (
      input: Parameters<OrdersFixture['edits']['editLineItems']>[2],
      id = order.id,
      tenant = f.a,
    ) => f.edits.editLineItems(tenant, id, input);

    expect(errorsOf(await edit({}))).toEqual([['input', 'BLANK']]);
    expect(
      errorsOf(
        await edit({ setQuantities: [{ lineItemId: kurtaLine, quantity: 2 }] }, order.id, f.b),
      ),
    ).toEqual([['id', 'NOT_FOUND']]);
    expect(
      errorsOf(
        await edit({
          setQuantities: [
            { lineItemId: kurtaLine, quantity: 2 },
            { lineItemId: kurtaLine, quantity: 3 },
            { lineItemId: dupattaLine, quantity: -1 },
          ],
          addVariants: [
            { variantId: chappal, quantity: 0 },
            { variantId: chappal, quantity: 1 },
          ],
        }),
      ),
    ).toEqual([
      ['input.setQuantities.1.lineItemId', 'INVALID'],
      ['input.setQuantities.2.quantity', 'INVALID'],
      ['input.addVariants.0.quantity', 'INVALID'],
      ['input.addVariants.1.variantId', 'INVALID'],
    ]);
    expect(errorsOf(await edit({ setQuantities: [{ lineItemId: newId(), quantity: 1 }] }))).toEqual(
      [['input.setQuantities.0.lineItemId', 'NOT_FOUND']],
    );
    const empty = await edit({
      setQuantities: [
        { lineItemId: kurtaLine, quantity: 0 },
        { lineItemId: dupattaLine, quantity: 0 },
      ],
    });
    expect(!empty.ok && empty.errors[0]!.message).toBe(
      'An order keeps at least one item: cancel it instead',
    );

    // Variants: one on the order already, one gone, one archived.
    const [shawl] = (await f.variantsOf(f.a, 'Shawl')) as [string];
    await f.admin.query(
      `UPDATE catalog.products SET status = 'archived'
        WHERE id = (SELECT product_id FROM catalog.variants WHERE id = $1)`,
      [shawl],
    );
    const variants = await edit({
      addVariants: [
        { variantId: kurta, quantity: 1 },
        { variantId: newId(), quantity: 1 },
        { variantId: shawl, quantity: 1 },
      ],
    });
    expect(errorsOf(variants)).toEqual([
      ['input.addVariants.0.variantId', 'INVALID'],
      ['input.addVariants.1.variantId', 'NOT_FOUND'],
      ['input.addVariants.2.variantId', 'INVALID'],
    ]);
    expect(!variants.ok && variants.errors.map((error) => error.message)).toEqual([
      '"Kurta" is on the order already: change its quantity instead',
      'Variant not found',
      '"Shawl" is archived, so it can\'t be sold',
    ]);

    // Stock: nine more kurtas are left, and ten chappals.
    const short = await edit({
      setQuantities: [{ lineItemId: kurtaLine, quantity: 11 }],
      addVariants: [{ variantId: chappal, quantity: 11 }],
    });
    expect(errorsOf(short)).toEqual([
      ['input.setQuantities.0.quantity', 'OUT_OF_STOCK'],
      ['input.addVariants.0.quantity', 'OUT_OF_STOCK'],
    ]);
    expect(!short.ok && short.errors.map((error) => error.message)).toEqual([
      'Only 9 more of "Kurta" left at Main location',
      'Only 10 of "Chappal" left at Main location',
    ]);
    // No more cash at the door than the law allows.
    const cash = await edit({ setQuantities: [{ lineItemId: kurtaLine, quantity: 90 }] });
    expect(errorsOf(cash)).toEqual([['input', 'COD_LIMIT']]);

    const unchanged = (await f.orders.get(f.a, order.id))!;
    expect(unchanged.version).toBe(order.version);
    expect(unchanged.lines).toEqual(order.lines);
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 1, available: 9 });
    expect(await f.level(f.a, chappal)).toMatchObject({ committed: 0, available: 10 });

    // Not more of an item no longer sold.
    await f.admin.query(
      `UPDATE catalog.products SET status = 'archived'
        WHERE id = (SELECT product_id FROM catalog.variants WHERE id = $1)`,
      [kurta],
    );
    const archived = await edit({ setQuantities: [{ lineItemId: kurtaLine, quantity: 2 }] });
    expect(errorsOf(archived)).toEqual([['input.setQuantities.0.quantity', 'INVALID']]);
    // Taking it off is fine.
    const taken = unwrap(await edit({ setQuantities: [{ lineItemId: kurtaLine, quantity: 0 }] }));
    expect(taken.lines.map((line) => [line.title, line.position])).toEqual([['Dupatta', 1]]);
  });

  it('keeps to what the order agreed: its discount, what was paid, its stage', async () => {
    const discounted = await f.order(f.a, [kurta, dupatta], { discount: '1,500' });
    const discount = await f.edits.editLineItems(f.a, discounted.id, {
      setQuantities: [{ lineItemId: lineOf(discounted, kurta).id, quantity: 0 }],
    });
    expect(errorsOf(discount)).toEqual([['input', 'INVALID']]);
    expect(!discount.ok && discount.errors[0]!.message).toBe(
      'Its discount of Rs 1,500 would be more than its items cost, Rs 1,000',
    );

    const prepaid = await f.order(f.a, [kurta, dupatta], { paymentMethod: 'prepaid' });
    const paid = await f.edits.editLineItems(f.a, prepaid.id, {
      setQuantities: [{ lineItemId: lineOf(prepaid, dupatta).id, quantity: 0 }],
    });
    expect(!paid.ok && paid.errors[0]!.message).toBe(
      'Rs 3,360 is paid on it already, more than its new total of Rs 2,360',
    );
    unwrap(await f.refunds.refund(f.a, prepaid.id, { amount: '100', method: 'cash' }));
    const refunded = await f.edits.editLineItems(f.a, prepaid.id, {
      addVariants: [{ variantId: chappal, quantity: 1 }],
    });
    expect(!refunded.ok && refunded.errors[0]!.message).toBe(
      "It has refunds, so its items can't change",
    );

    // Packed, it is unpacked first; shipped or cancelled, never.
    const packed = await f.order(f.a, [kurta]);
    unwrap(await f.orders.confirm(f.a, packed.id));
    unwrap(await f.orders.markPacked(f.a, packed.id));
    const addChappal = { addVariants: [{ variantId: chappal, quantity: 1 }] };
    const whilePacked = await f.edits.editLineItems(f.a, packed.id, addChappal);
    expect(!whilePacked.ok && whilePacked.errors[0]!.message).toBe(
      'It is packed: mark it unpacked first, then change its items',
    );
    unwrap(await f.orders.markUnpacked(f.a, packed.id));
    expect(unwrap(await f.edits.editLineItems(f.a, packed.id, addChappal)).stage).toBe('to_pack');
    unwrap(await f.fulfillments.fulfill(f.a, packed.id, {}));
    expect(errorsOf(await f.edits.editLineItems(f.a, packed.id, addChappal))).toEqual([
      ['id', 'INVALID'],
    ]);
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    expect(errorsOf(await f.edits.editLineItems(f.a, cancelled.id, addChappal))).toEqual([
      ['id', 'INVALID'],
    ]);
  });

  it('waits for the rest of a transfer, and holds an order the edit makes risky', async () => {
    const transfer = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    const paid = unwrap(await f.orders.recordPayment(f.a, transfer.id));
    expect(paid).toMatchObject({ financialStatus: 'paid', stage: 'to_pack' });
    const more = unwrap(
      await f.edits.editLineItems(f.a, transfer.id, {
        addVariants: [{ variantId: dupatta, quantity: 1, price: '800' }],
      }),
    );
    expect(more).toMatchObject({
      total: 3_160_00n,
      amountPaid: 2_360_00n,
      codAmount: 0n,
      financialStatus: 'partially_paid',
      stage: 'awaiting_payment',
      paidAt: null,
    });
    expect(lineOf(more, dupatta).unitPrice).toBe(800_00n);
    const less = unwrap(
      await f.edits.editLineItems(f.a, transfer.id, {
        setQuantities: [{ lineItemId: lineOf(more, dupatta).id, quantity: 0 }],
      }),
    );
    expect(less).toMatchObject({ financialStatus: 'paid', stage: 'to_pack' });
    expect(less.paidAt).toBeInstanceOf(Date);

    // A new customer's order, held at 0.40: ten kurtas are many, and Rs 23,600 a lot.
    unwrap(await f.riskSettings.update(f.a, { holdAt: 0.4, highValue: '5,000' }));
    await f.stock(f.a, kurta, 20);
    const order = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, phone: '0311-7654321' },
    });
    expect(order).toMatchObject({
      confirmationStatus: 'pending',
      risk: { score: 10, level: 'low' },
    });
    const risky = unwrap(
      await f.edits.editLineItems(f.a, order.id, {
        setQuantities: [{ lineItemId: lineOf(order, kurta).id, quantity: 10 }],
      }),
    );
    expect(risky).toMatchObject({
      confirmationStatus: 'needs_review',
      stage: 'needs_review',
      risk: { score: 45, level: 'medium' },
    });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 2 });
    expect(timeline.items.map((entry) => [entry.kind, entry.message])).toEqual([
      [
        'held',
        'Held for review: risk 0.45 (medium). High value: Rs 23,600; 10 items, more than most ' +
          'orders; First order from this number',
      ],
      ['edited', 'Changed the items: 10 × Kurta instead of 1; Rs 23,600 instead of Rs 2,360'],
    ]);
  });
  it('changes what an order charges for delivery and takes off, its totals following', async () => {
    unwrap(await new TaxSettingsService(f.db).update(f.a, { rate: 18 }));
    const order = await f.order(f.a, [kurta, dupatta], { shippingPrice: '250' });
    expect(order).toMatchObject({ total: 3_610_00n, totalTax: 512_54n });
    const agent = staff('confirmation_agent');

    const waived = unwrap(
      await f.edits.editCharges(agent, order.id, { shippingPrice: '0', discount: '360' }),
    );
    expect(waived).toMatchObject({
      subtotal: 3_360_00n,
      shipping: 0n,
      discount: 360_00n,
      total: 3_000_00n,
      codAmount: 3_000_00n,
      version: order.version + 1,
    });
    // Each line's tax is on what is paid for it now, after its share of the discount.
    expect(waived.totalTax).toBe(waived.lines.reduce((sum, line) => sum + line.tax, 0n));
    expect(waived.totalTax).toBeLessThan(order.totalTax);
    expect(waived.lines.map((line) => [line.id, line.quantity])).toEqual(
      order.lines.map((line) => [line.id, line.quantity]),
    );
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 1 });
    const [entry] = (await f.orders.timeline(f.a, order.id, { first: 1 })).items;
    expect(entry).toMatchObject({
      kind: 'edited',
      message:
        'Changed the delivery charge to Rs 0 from Rs 250, and the discount to Rs 360 from Rs 0; ' +
        'Rs 3,000 instead of Rs 3,610',
      actorKind: 'staff',
    });
    const events = (await f.outbox()).filter((event) => event.event_type === 'order.updated');
    expect(events.at(-1)!.payload.changed).toEqual(['shipping', 'discount']);

    // The same charges change nothing.
    const same = unwrap(await f.edits.editCharges(agent, order.id, { shippingPrice: '0' }));
    expect(same.version).toBe(waived.version);

    expect(errorsOf(await f.edits.editCharges(agent, order.id, {}))).toEqual([['input', 'BLANK']]);
    expect(errorsOf(await f.edits.editCharges(agent, order.id, { shippingPrice: 'free' }))).toEqual(
      [['input.shippingPrice', 'INVALID']],
    );
    const tooMuch = await f.edits.editCharges(agent, order.id, { discount: '5,000' });
    expect(!tooMuch.ok && tooMuch.errors[0]).toEqual({
      field: ['input', 'discount'],
      code: 'INVALID',
      message: 'Its discount of Rs 5,000 would be more than its items cost, Rs 3,360',
    });
    const prepaid = await f.order(f.a, [kurta, dupatta], { paymentMethod: 'prepaid' });
    const paid = await f.edits.editCharges(f.a, prepaid.id, { discount: '100' });
    expect(!paid.ok && paid.errors[0]).toMatchObject({
      field: ['input', 'discount'],
      message: 'Rs 3,360 is paid on it already, more than its new total of Rs 3,260',
    });
    // What was taken off for paying by transfer stays part of the discount; the rest may go.
    const transfer = unwrap(
      await f.db.tenant(f.a.shopId, (tx) =>
        f.orders.placeIn(
          tx,
          {
            shopId: f.a.shopId,
            currency: 'PKR',
            actor: 'system',
            source: 'online_store',
            how: 'from the online store',
          },
          {
            field: [],
            lines: [{ variantId: kurta, quantity: 1, price: null }],
            address: checkAddress(new InputChecker(), [], ADDRESS)!,
            email: null,
            paymentMethod: 'bank_transfer',
            shipping: 250_00n,
            discount: 300_00n,
            transferDiscount: 100_00n,
            discountCodes: ['EID10'],
            advance: 0n,
            locationId: null,
            note: '',
            tags: [],
          },
        ),
      ),
    );
    const below = await f.edits.editCharges(f.a, transfer.id, { discount: '50' });
    expect(!below.ok && below.errors[0]).toEqual({
      field: ['input', 'discount'],
      code: 'INVALID',
      message: "Rs 100 of the discount was taken off for paying by transfer: it can't be less",
    });
    expect(unwrap(await f.edits.editCharges(f.a, transfer.id, { discount: '100' }))).toMatchObject({
      discount: 100_00n,
      transferDiscount: 100_00n,
      discountCodes: ['EID10'],
      total: 2_510_00n,
      financialStatus: 'pending',
    });
    unwrap(await f.orders.confirm(f.a, order.id));
    unwrap(await f.orders.markPacked(f.a, order.id));
    const packed = await f.edits.editCharges(f.a, order.id, { shippingPrice: '250' });
    expect(!packed.ok && packed.errors[0]!.message).toBe(
      'It is packed: mark it unpacked first, then change its charges',
    );
  });

  it('merges an order its customer placed twice into the other, as one parcel', async () => {
    const first = await f.order(f.a, [kurta], {
      shippingPrice: '250',
      note: 'Call after 5pm',
      tags: ['eid'],
    });
    const second = await f.order(f.a, [kurta, dupatta], {
      shippingPrice: '250',
      discount: '100',
      note: 'Gift wrap the dupatta',
      tags: ['gift'],
    });
    const historyBefore = await f.inventory.history(f.a, kurta, { first: 50 });
    const link = unwrap(await f.links.createLink(f.a, second.id));
    const agent = staff('confirmation_agent');

    const { order, merged } = unwrap(await f.edits.merge(agent, second.id, first.id));
    // The kurtas join at the price both were sold at; the dupatta is added. One delivery charge.
    expect(order.lines.map((line) => [line.title, line.quantity, line.unitPrice])).toEqual([
      ['Kurta', 2, 2_360_00n],
      ['Dupatta', 1, 1_000_00n],
    ]);
    expect(order).toMatchObject({
      subtotal: 5_720_00n,
      discount: 100_00n,
      shipping: 250_00n,
      total: 5_870_00n,
      codAmount: 5_870_00n,
      note: 'Call after 5pm\n\nGift wrap the dupatta',
      tags: ['eid', 'gift'],
      stage: 'needs_confirmation',
      risk: { score: 10 },
    });
    expect(merged).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
      cancelReason: 'merged',
      mergedInto: { orderId: first.id, number: first.number },
    });
    // Its customer's link says which order it joined.
    const view = await f.links.viewLink(link.url.slice('https://hatti.test/o/'.length));
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    expect(orderLinkPage(view).html).toContain(
      'Your order #1002 was joined with your order #1001, and A will send them together as #1001.',
    );
    // Its stock was committed already, at the same location: nothing moves.
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 2, available: 8 });
    expect(await f.level(f.a, dupatta)).toMatchObject({ committed: 1, available: 9 });
    expect((await f.inventory.history(f.a, kurta, { first: 50 })).items).toHaveLength(
      historyBefore.items.length,
    );

    const [intoEntry] = (await f.orders.timeline(f.a, first.id, { first: 1 })).items;
    expect(intoEntry).toMatchObject({
      kind: 'merged',
      message:
        'Merged #1002 into this order: 2 × Kurta instead of 1, added 1 × Dupatta; ' +
        'Rs 5,870 instead of Rs 2,610',
      actorKind: 'staff',
    });
    const [mergedEntry] = (await f.orders.timeline(f.a, second.id, { first: 1 })).items;
    expect(mergedEntry).toMatchObject({
      kind: 'merged',
      message: 'Merged into #1001, which took its items',
    });
    const events = (await f.outbox()).filter((event) =>
      ['order.updated', 'order.cancelled'].includes(event.event_type),
    );
    expect(events.slice(-2).map((event) => [event.event_type, event.payload])).toEqual([
      ['order.cancelled', expect.objectContaining({ reason: 'merged' })],
      ['order.updated', expect.objectContaining({ changed: ['lineItems', 'note', 'tags'] })],
    ]);

    // The customer placed one order: the one merged counts for nothing in their history.
    const stats = await f.orders.customerStats(f.a, [order.customerId]);
    expect(stats.get(order.customerId)).toMatchObject({ count: 1, cancelled: 0, inProgress: 1 });
    expect(errorsOf(await f.edits.merge(agent, second.id, first.id))).toEqual([['id', 'INVALID']]);
  });

  it('scores the order merged into without the other, and moves stock between locations', async () => {
    // The second order of a new customer scores as another order from the number.
    const first = await f.order(f.a, [kurta]);
    const second = await f.order(f.a, [dupatta]);
    expect(second.risk).toMatchObject({ score: 25 });

    // Merged the other way, older into newer: the newer is a first order again, and COD health
    // counts one order placed, none cancelled.
    const { order } = unwrap(await f.edits.merge(f.a, first.id, second.id));
    expect(order.risk).toMatchObject({ score: 10 });
    const health = unwrap(
      await new CodHealthService(f.db).report(f.a, {
        placedFrom: new Date(Date.now() - 3_600_000),
        placedBefore: new Date(Date.now() + 3_600_000),
        first: 10,
      }),
    );
    expect(health.confirmation).toMatchObject({ placed: 1, cancelled: 0 });

    const store = unwrap(await f.locations.add(f.a, { name: 'Store' }));
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: kurta, locationId: store.id, quantity: 3 }],
      }),
    );
    const fromStore = await f.order(f.a, [kurta], { locationId: store.id });
    // From the store, its kurta is let go there and committed where the other ships from.
    const kurtaAt = async (locationId: string) =>
      (await f.inventory.item(f.a, kurta))!.levels.find(
        (level) => level.location.id === locationId,
      );
    expect(await kurtaAt(store.id)).toMatchObject({ committed: 1 });
    unwrap(await f.edits.merge(f.a, fromStore.id, second.id));
    expect(await kurtaAt(store.id)).toMatchObject({ committed: 0, available: 3 });
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 2, available: 8 });
  });

  it('merges only what can be one parcel', async () => {
    const order = await f.order(f.a, [kurta]);
    const other = await f.order(f.a, [dupatta]);
    const merge = (id: string, intoId: string, tenant = f.a) => f.edits.merge(tenant, id, intoId);

    expect(errorsOf(await merge(order.id, order.id))).toEqual([['intoId', 'INVALID']]);
    expect(errorsOf(await merge(order.id, other.id, f.b))).toEqual([['id', 'NOT_FOUND']]);
    expect(errorsOf(await merge(order.id, newId()))).toEqual([['intoId', 'NOT_FOUND']]);
    const someoneElse = await f.order(f.a, [dupatta], {
      shippingAddress: { ...ADDRESS, phone: '0311-7654321' },
    });
    expect(errorsOf(await merge(someoneElse.id, order.id))).toEqual([['intoId', 'INVALID']]);
    const byTransfer = await f.order(f.a, [dupatta], { paymentMethod: 'bank_transfer' });
    expect(errorsOf(await merge(byTransfer.id, order.id))).toEqual([['intoId', 'INVALID']]);
    const paidAhead = await f.order(f.a, [dupatta], { advancePaid: '250' });
    const paid = await merge(paidAhead.id, order.id);
    expect(!paid.ok && paid.errors[0]!.message).toBe(
      `#${paidAhead.number} has money paid or asked for in advance: merge the other order into ` +
        'it instead',
    );
    // The other way round, it takes the order without an advance.
    expect(unwrap(await merge(other.id, paidAhead.id)).order.amountPaid).toBe(250_00n);

    unwrap(await f.orders.confirm(f.a, order.id));
    unwrap(await f.orders.markPacked(f.a, order.id));
    const packed = await merge(paidAhead.id, order.id);
    expect(!packed.ok && packed.errors[0]).toMatchObject({
      field: ['intoId'],
      message: `#${order.number} is packed: mark it unpacked first`,
    });
    // Cancelling as merged is merging's alone.
    expect(errorsOf(await f.orders.cancel(f.a, someoneElse.id, { reason: 'merged' }))).toEqual([
      ['reason', 'INVALID'],
    ]);
    expect(
      errorsOf(await f.orders.bulkCancel(f.a, [someoneElse.id], { reason: 'merged' })),
    ).toEqual([['reason', 'INVALID']]);
  });
});
