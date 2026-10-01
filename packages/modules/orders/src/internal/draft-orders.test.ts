import 'reflect-metadata';
import type { StaffRole, TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftLinkPage } from './link-pages.js';
import type { DraftLinkView, DraftOrderInput } from './draft-order.service.js';
import type { AddressForm } from './links.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Draft orders', () => {
  let f: OrdersFixture;
  let kurta: string;
  let size8: string;
  let size9: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [size8, size9] = (await f.variantsOf(f.a, 'Peshawari Chappal', {
      sizes: ['8', '9'],
      price: '3,499',
    })) as [string, string];
    for (const variant of [kurta, size8, size9]) await f.stock(f.a, variant, 5);
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

  /** A cash-on-delivery draft for Ayesha: two kurtas at a price agreed, and a pair of size 9. */
  const draft = async (extra: DraftOrderInput = {}, tenant = f.a) =>
    unwrap(
      await f.drafts.create(tenant, {
        lineItems: [
          { variantId: kurta, quantity: 2, price: '1,800' },
          { variantId: size9, quantity: 1 },
        ],
        shippingAddress: ADDRESS,
        shippingPrice: '250',
        ...extra,
      }),
    );

  /** The secret at the end of a link. */
  const tokenOf = (url: string) => url.slice('https://hatti.test/d/'.length);

  /** The digest of what a link's page shows now, which its form carries. */
  const shownOn = async (token: string) => {
    const view = await f.drafts.viewLink(token);
    if (view.kind !== 'open') throw new Error(`Expected a draft to confirm, got ${view.kind}`);
    return view.shown;
  };

  /** Order and draft events, without the catalog, stock and customer events around them. */
  const events = async () =>
    (await f.outbox()).filter((event) => /^(draft_)?order\./.test(event.event_type));

  const orderCount = async () =>
    (await f.admin.query<{ count: number }>('SELECT count(*)::int AS count FROM orders.orders'))
      .rows[0]!.count;

  /** Gives the shop a policy as the online store saves one: a new version, now its body. */
  const policy = async (type: string, body: string) => {
    const versionId = newId();
    await f.admin.query(
      `INSERT INTO online_store.policy_versions (shop_id, id, type, body) VALUES ($1, $2, $3, $4)`,
      [f.a.shopId, versionId, type, body],
    );
    await f.admin.query(
      `INSERT INTO online_store.policies (shop_id, type, id, body, version_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shop_id, type) DO UPDATE SET body = $4, version_id = $5`,
      [f.a.shopId, type, newId(), body, versionId],
    );
    return versionId;
  };

  /** Why a link's action did not happen, if it did not. */
  const problemOf = (view: DraftLinkView) =>
    view.kind === 'open' || view.kind === 'completed' ? view.problem : view.kind;

  const messageOf = (whatsappUrl: string) => decodeURIComponent(whatsappUrl.split('?text=')[1]!);

  /** An address as the customer might type it on their page, without a number. */
  const FORM: AddressForm = {
    name: 'Ayesha Khan',
    address1: 'House 12, Street 4, Block 5',
    address2: '',
    landmark: '',
    city: 'khi',
    province: '',
    zip: '',
    phone: '',
  };

  it('keeps the items at the prices agreed, and the address once the customer sends it', async () => {
    const started = unwrap(
      await f.drafts.create(f.a, {
        lineItems: [
          { variantId: kurta, quantity: 2, price: '1,800' },
          { variantId: size8, quantity: 1 },
        ],
        source: 'instagram',
        shippingPrice: '250',
        note: 'Asked for gift wrapping',
        tags: ['eid'],
      }),
    );
    expect(started).toMatchObject({
      number: 1,
      status: 'open',
      source: 'instagram',
      paymentMethod: 'cash_on_delivery',
      currency: 'PKR',
      subtotal: 709_900n,
      discount: 0n,
      shipping: 25_000n,
      total: 734_900n,
      advancePaid: 0n,
      codAmount: 734_900n,
      phone: null,
      shippingAddress: null,
      locationId: null,
      note: 'Asked for gift wrapping',
      tags: ['eid'],
      orderId: null,
      linkExpiresAt: null,
      actorKind: 'app',
      version: 1,
    });
    expect(started.lines).toEqual([
      expect.objectContaining({
        title: 'Kurta',
        quantity: 2,
        unitPrice: 180_000n,
        total: 360_000n,
      }),
      expect.objectContaining({
        title: 'Peshawari Chappal',
        variantTitle: '8',
        sku: 'PES-8',
        unitPrice: 349_900n,
      }),
    ]);

    // The address comes later in the chat; fields left out stay as they were.
    const addressed = unwrap(
      await f.drafts.update(f.a, started.id, { shippingAddress: ADDRESS, email: 'a@example.com' }),
    );
    expect(addressed).toMatchObject({
      version: 2,
      phone: '+923001234567',
      email: 'a@example.com',
      shippingAddress: expect.objectContaining({ city: 'Karachi', provinceCode: 'SD' }),
      lines: started.lines,
      note: 'Asked for gift wrapping',
    });
    // Nothing new, nothing written.
    expect(
      unwrap(await f.drafts.update(f.a, started.id, { note: ' Asked for gift wrapping ' })),
    ).toMatchObject({ version: 2 });
    // New lines are priced now; null takes a field off.
    const changed = unwrap(
      await f.drafts.update(f.a, started.id, {
        lineItems: [{ variantId: size9, quantity: 1 }],
        shippingPrice: null,
        tags: null,
      }),
    );
    expect(changed).toMatchObject({ subtotal: 349_900n, shipping: 0n, total: 349_900n, tags: [] });

    expect((await draft()).number).toBe(2);
    expect((await events()).map((event) => [event.event_type, event.payload.changed])).toEqual([
      ['draft_order.created', undefined],
      ['draft_order.updated', ['shippingAddress', 'email']],
      ['draft_order.updated', ['lineItems', 'shippingPrice', 'tags']],
      ['draft_order.created', undefined],
    ]);

    // Other shops see nothing of it.
    expect(await f.drafts.get(f.b, started.id)).toBeNull();
    expect(errorsOf(await f.drafts.update(f.b, started.id, { note: 'x' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect((await f.drafts.list(f.b, { first: 10 })).items).toEqual([]);
  });

  it('checks a draft as an order is checked', async () => {
    const [archived] = (await f.variantsOf(f.a, 'Old Shawl')) as [string];
    await f.admin.query(
      `UPDATE catalog.products SET status = 'archived' WHERE title = 'Old Shawl'`,
    );
    const create = async (input: DraftOrderInput) => errorsOf(await f.drafts.create(f.a, input));
    const line = { variantId: kurta, quantity: 1 };

    expect(await create({})).toEqual([['input.lineItems', 'BLANK']]);
    expect(await create({ lineItems: [] })).toEqual([['input.lineItems', 'BLANK']]);
    expect(
      await create({
        lineItems: [
          { variantId: newId(), quantity: 1 },
          { variantId: archived, quantity: 0 },
        ],
      }),
    ).toEqual([['input.lineItems.1.quantity', 'INVALID']]);
    expect(
      await create({
        lineItems: [
          { variantId: newId(), quantity: 1 },
          { variantId: archived, quantity: 1 },
        ],
      }),
    ).toEqual([
      ['input.lineItems.0.variantId', 'NOT_FOUND'],
      ['input.lineItems.1.variantId', 'INVALID'],
    ]);
    expect(await create({ lineItems: [line], discount: '2,001' })).toEqual([
      ['input.discount', 'INVALID'],
    ]);
    expect(await create({ lineItems: [line], advancePaid: '2,001' })).toEqual([
      ['input.advancePaid', 'INVALID'],
    ]);
    expect(
      await create({ lineItems: [line], paymentMethod: 'prepaid', advancePaid: '200' }),
    ).toEqual([['input.advancePaid', 'INVALID']]);
    // More cash on delivery than the law allows an order, unless an advance brings it within.
    const bridal = { variantId: kurta, quantity: 1, price: '250,000' };
    expect(await create({ lineItems: [bridal] })).toEqual([['input.advancePaid', 'COD_LIMIT']]);
    const within = unwrap(
      await f.drafts.create(f.a, { lineItems: [bridal], advancePaid: '50,000' }),
    );
    expect(within.codAmount).toBe(200_000_00n);
    unwrap(await f.drafts.create(f.a, { lineItems: [bridal], paymentMethod: 'prepaid' }));
    expect(await create({ lineItems: [line], locationId: newId() })).toEqual([
      ['input.locationId', 'NOT_FOUND'],
    ]);
    expect(
      await create({ lineItems: [line], source: 'online_store' as DraftOrderInput['source'] }),
    ).toEqual([['input.source', 'INVALID']]);
    expect(
      await create({ lineItems: [line], shippingAddress: { ...ADDRESS, phone: '12345' } }),
    ).toEqual([['input.shippingAddress.phone', 'INVALID']]);

    const open = await draft();
    expect(errorsOf(await f.drafts.update(f.a, open.id, { lineItems: null }))).toEqual([
      ['input.lineItems', 'BLANK'],
    ]);
    // Staff enter drafts by hand; apps send them.
    expect((await draft({}, staff('confirmation_agent'))).source).toBe('manual');
    expect(open.source).toBe('api');
    expect(await orderCount()).toBe(0);
  });

  it('lists drafts newest first, by status', async () => {
    const [first, second, third] = [await draft(), await draft(), await draft()];
    unwrap(await f.drafts.complete(f.a, second!.id));
    const names = async (options: Parameters<OrdersFixture['drafts']['list']>[1]) =>
      (await f.drafts.list(f.a, options)).items.map((item) => item.number);
    expect(await names({ first: 10 })).toEqual([3, 2, 1]);
    expect(await names({ first: 10, status: 'open' })).toEqual([3, 1]);
    expect(await names({ first: 10, status: 'completed' })).toEqual([2]);
    const page = await f.drafts.list(f.a, { first: 2 });
    expect(page.hasNextPage).toBe(true);
    expect(await names({ first: 2, after: page.items[1]!.id })).toEqual([1]);
    expect([first, third].map((item) => item!.status)).toEqual(['open', 'open']);
  });

  it('places a draft as an order at its prices, once', async () => {
    const open = await draft({
      source: 'whatsapp',
      discount: '100',
      advancePaid: '250',
      note: 'Deliver after 5 pm',
      tags: ['eid'],
    });
    // The catalog's price changes after the price was agreed.
    await f.admin.query('UPDATE catalog.variants SET price = 250000 WHERE id = $1', [kurta]);
    await f.admin.query('DELETE FROM platform.outbox_events');

    const completed = unwrap(await f.drafts.complete(staff('confirmation_agent'), open.id));
    expect(completed).toMatchObject({ status: 'completed', version: 2 });
    expect(completed.completedAt).toBeInstanceOf(Date);
    const order = (await f.orders.get(f.a, completed.orderId!))!;
    expect(order).toMatchObject({
      number: 1001,
      source: 'whatsapp',
      confirmationStatus: 'pending',
      stage: 'needs_confirmation',
      subtotal: 709_900n,
      discount: 10_000n,
      shipping: 25_000n,
      total: 724_900n,
      amountPaid: 25_000n,
      codAmount: 699_900n,
      financialStatus: 'partially_paid',
      phone: '+923001234567',
      note: 'Deliver after 5 pm',
      tags: ['eid'],
    });
    expect(order.lines.map((line) => [line.title, line.quantity, line.unitPrice])).toEqual([
      ['Kurta', 2, 180_000n],
      ['Peshawari Chappal', 1, 349_900n],
    ]);
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 2, available: 3 });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 5 });
    expect(timeline.items.map((entry) => [entry.kind, entry.actorKind, entry.message])).toEqual([
      [
        'created',
        'staff',
        'Order #1001 placed by staff from draft #D1: Rs 7,249, cash on delivery',
      ],
    ]);
    expect((await events()).map((event) => [event.event_type, event.payload])).toEqual([
      ['order.created', expect.objectContaining({ source: 'whatsapp' })],
      [
        'draft_order.completed',
        { orderId: order.id, confirmedByCustomer: false, status: 'completed', version: 2 },
      ],
    ]);

    // Once only: completing again changes nothing, and a completed draft stays as it is.
    expect(unwrap(await f.drafts.complete(f.a, open.id))).toEqual(completed);
    expect(await orderCount()).toBe(1);
    expect(errorsOf(await f.drafts.update(f.a, open.id, { note: 'x' }))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(errorsOf(await f.drafts.delete(f.a, open.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.drafts.createLink(f.a, open.id))).toEqual([['id', 'INVALID']]);
  });

  it('keeps a draft open when its order cannot be placed', async () => {
    const unaddressed = await draft({ shippingAddress: null });
    expect(await f.drafts.complete(f.a, unaddressed.id)).toEqual({
      ok: false,
      errors: [{ field: ['id'], code: 'INVALID', message: "Add the customer's address first" }],
    });

    const tooMany = await draft({ lineItems: [{ variantId: size8, quantity: 6 }] });
    expect(errorsOf(await f.drafts.complete(f.a, tooMany.id))).toEqual([
      ['lineItems.0.quantity', 'OUT_OF_STOCK'],
    ]);
    // Taken off sale after the draft was made.
    const withKurta = await draft();
    await f.admin.query(`UPDATE catalog.products SET status = 'archived' WHERE title = 'Kurta'`);
    expect(errorsOf(await f.drafts.complete(f.a, withKurta.id))).toEqual([
      ['lineItems.0.variantId', 'INVALID'],
    ]);
    expect((await f.drafts.get(f.a, tooMany.id))?.status).toBe('open');
    expect(await orderCount()).toBe(0);

    // An open draft can be deleted.
    expect(unwrap(await f.drafts.delete(f.a, tooMany.id))).toEqual({ id: tooMany.id });
    expect(await f.drafts.get(f.a, tooMany.id)).toBeNull();
    expect(errorsOf(await f.drafts.delete(f.a, tooMany.id))).toEqual([['id', 'NOT_FOUND']]);
  });

  it('sends the customer a link, where confirming places a confirmed order', async () => {
    const open = await draft({ source: 'whatsapp' });
    const before = Date.now();
    const first = unwrap(await f.drafts.createLink(staff('owner'), open.id));
    expect(first.url).toMatch(/^https:\/\/hatti\.test\/d\/[A-Za-z0-9_-]{22}$/);
    expect(first.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 72 * 3_600_000);
    expect(first.draftOrder).toMatchObject({ version: 2, linkExpiresAt: first.expiresAt });
    // To the customer's number for staff who see numbers whole; to a chat of their choosing for
    // the rest.
    const message = decodeURIComponent(first.whatsappUrl.split('?text=')[1]!);
    expect(first.whatsappUrl).toMatch(/^https:\/\/wa\.me\/923001234567\?text=/);
    expect(message).toBe(
      `Please confirm your order from A:\n${first.url}\nاپنا آرڈر کنفرم کرنے کے لیے یہ لنک کھولیں۔`,
    );
    const second = unwrap(
      await f.drafts.createLink(staff('confirmation_agent'), open.id, { expiresInHours: 24 }),
    );
    expect(second.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(second.expiresAt.getTime()).toBeLessThan(before + 25 * 3_600_000);

    // A new link replaces the old one; nothing but a well-formed, current secret shows anything.
    for (const token of [tokenOf(first.url), 'short', `${tokenOf(second.url)}x`]) {
      expect(await f.drafts.viewLink(token)).toEqual({ kind: 'not_found' });
      expect(await f.drafts.confirmLink(token, 'x')).toEqual({ kind: 'not_found' });
    }
    const token = tokenOf(second.url);
    const view = await f.drafts.viewLink(token);
    expect(view).toMatchObject({
      kind: 'open',
      shop: { name: 'A', timezone: 'Asia/Karachi', accent: null, logo: null },
      draft: { id: open.id, version: 3 },
      shown: expect.stringMatching(/^[\w-]{22}$/),
      problem: null,
    });
    const seen = await shownOn(token);

    // A page opened before the delivery charge changed does not confirm it: the customer sees the
    // new charge first. What the page does not show, such as a note, may change.
    unwrap(await f.drafts.update(f.a, open.id, { shippingPrice: '300' }));
    expect(await f.drafts.confirmLink(token, seen)).toMatchObject({
      kind: 'open',
      problem: { kind: 'changed' },
    });
    expect(await orderCount()).toBe(0);
    const seenAgain = await shownOn(token);
    unwrap(await f.drafts.update(f.a, open.id, { note: 'Called her at 5 pm' }));

    await f.admin.query('DELETE FROM platform.outbox_events');
    const confirmed = await f.drafts.confirmLink(token, seenAgain);
    if (confirmed.kind !== 'completed') throw new Error(`Expected an order, got ${confirmed.kind}`);
    expect(confirmed.order).toMatchObject({
      source: 'whatsapp',
      confirmationStatus: 'confirmed',
      stage: 'to_pack',
      total: 739_900n,
      note: 'Called her at 5 pm',
    });
    expect(confirmed.order.confirmedAt).toBeInstanceOf(Date);
    expect(confirmed.draft).toMatchObject({ status: 'completed', orderId: confirmed.order.id });
    const timeline = await f.orders.timeline(f.a, confirmed.order.id, { first: 5 });
    expect(timeline.items.map((entry) => [entry.actorKind, entry.message])).toEqual([
      [
        'system',
        'Order #1001 placed from draft #D1 when the customer confirmed it through its link: ' +
          'Rs 7,399, cash on delivery',
      ],
    ]);
    const { rows: adjustments } = await f.admin.query<{ actor_kind: string }>(
      `SELECT actor_kind FROM inventory.adjustments WHERE reason = 'committed'`,
    );
    expect(adjustments).toEqual([{ actor_kind: 'system' }]);
    expect(
      (await events()).map((event) => [event.event_type, event.payload.confirmedByCustomer]),
    ).toEqual([
      ['order.created', undefined],
      ['draft_order.completed', true],
    ]);

    // Confirming again, or looking again, shows the order; there is still one.
    expect(await f.drafts.confirmLink(token, seenAgain)).toMatchObject({
      kind: 'completed',
      order: { id: confirmed.order.id },
    });
    expect(await f.drafts.viewLink(token)).toMatchObject({ kind: 'completed' });
    expect(await orderCount()).toBe(1);
  });

  it('gives links only to drafts a customer can confirm, and takes them back', async () => {
    const prepaid = await draft({ paymentMethod: 'prepaid' });
    expect(errorsOf(await f.drafts.createLink(f.a, prepaid.id))).toEqual([['id', 'INVALID']]);
    const open = await draft();
    for (const expiresInHours of [0, 721, 1.5]) {
      expect(errorsOf(await f.drafts.createLink(f.a, open.id, { expiresInHours }))).toEqual([
        ['expiresInHours', 'INVALID'],
      ]);
    }
    expect(errorsOf(await f.drafts.createLink(f.b, open.id))).toEqual([['id', 'NOT_FOUND']]);

    // A draft that loses its address keeps its link, whose page asks for the address again; one
    // that becomes prepaid loses it.
    let link = unwrap(await f.drafts.createLink(f.a, open.id));
    const moved = unwrap(await f.drafts.update(f.a, open.id, { shippingAddress: null }));
    expect(moved).toMatchObject({ linkExpiresAt: link.expiresAt, phone: null });
    expect(await f.drafts.viewLink(tokenOf(link.url))).toMatchObject({
      kind: 'open',
      draft: { shippingAddress: null },
    });
    unwrap(await f.drafts.update(f.a, open.id, { shippingAddress: ADDRESS }));
    unwrap(await f.drafts.update(f.a, open.id, { note: 'Still cash on delivery' }));
    expect(await f.drafts.viewLink(tokenOf(link.url))).toMatchObject({ kind: 'open' });
    unwrap(await f.drafts.update(f.a, open.id, { paymentMethod: 'prepaid' }));
    expect(await f.drafts.viewLink(tokenOf(link.url))).toEqual({ kind: 'not_found' });
    expect((await events()).at(-1)?.payload.changed).toEqual(['paymentMethod', 'link']);

    // Deleting a draft takes its link with it.
    unwrap(await f.drafts.update(f.a, open.id, { paymentMethod: 'cash_on_delivery' }));
    link = unwrap(await f.drafts.createLink(f.a, open.id));
    unwrap(await f.drafts.delete(f.a, open.id));
    expect(await f.drafts.viewLink(tokenOf(link.url))).toEqual({ kind: 'not_found' });
  });

  it('stops an expired link, and holds blocked or risky confirmations for review', async () => {
    const expiring = await draft();
    const link = unwrap(await f.drafts.createLink(f.a, expiring.id));
    await f.admin.query(
      `UPDATE orders.draft_orders SET link_expires_at = now() - interval '1 second'`,
    );
    const token = tokenOf(link.url);
    expect(await f.drafts.viewLink(token)).toEqual({
      kind: 'expired',
      shop: { name: 'A', timezone: 'Asia/Karachi', accent: null, logo: null },
    });
    expect(await f.drafts.confirmLink(token, 'x')).toMatchObject({ kind: 'expired' });
    expect(await orderCount()).toBe(0);

    // Sold out since the link went: the customer is told which item, and the draft stays open.
    const soldOut = await draft({
      lineItems: [
        { variantId: kurta, quantity: 1 },
        { variantId: size8, quantity: 1 },
      ],
    });
    const soldOutLink = unwrap(await f.drafts.createLink(f.a, soldOut.id));
    await f.stock(f.a, size8, 0);
    const soldOutToken = tokenOf(soldOutLink.url);
    expect(await f.drafts.confirmLink(soldOutToken, await shownOn(soldOutToken))).toMatchObject({
      kind: 'open',
      problem: { kind: 'unavailable', lines: [1] },
    });
    expect(await orderCount()).toBe(0);

    // A blocked number's confirmation places the order, held for review.
    unwrap(await f.blocklist.add(f.a, { phone: ADDRESS.phone, reason: 'fake_orders' }));
    const blocked = await draft();
    const blockedLink = unwrap(await f.drafts.createLink(f.a, blocked.id));
    const blockedToken = tokenOf(blockedLink.url);
    const held = await f.drafts.confirmLink(blockedToken, await shownOn(blockedToken));
    expect(held).toMatchObject({
      kind: 'completed',
      order: { confirmationStatus: 'needs_review', stage: 'needs_review', confirmedAt: null },
    });
  });

  it('lets the customer add their address and number through the link, then correct it', async () => {
    const unaddressed = await draft({ shippingAddress: null });
    const link = unwrap(await f.drafts.createLink(staff('owner'), unaddressed.id));
    expect(link.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(messageOf(link.whatsappUrl)).toBe(
      `Please add your address and confirm your order from A:\n${link.url}\n` +
        'اپنا پتہ لکھ کر آرڈر کنفرم کرنے کے لیے یہ لنک کھولیں۔',
    );
    const token = tokenOf(link.url);
    const seen = await shownOn(token);

    // Nothing to confirm until there is an address: the page asks for it.
    expect(await f.drafts.confirmLink(token, seen)).toMatchObject({
      kind: 'open',
      problem: null,
      draft: { status: 'open', shippingAddress: null },
    });

    // Without a number on the draft, the customer gives theirs, which is checked like the rest.
    const typed = { ...FORM, city: '', phone: '12345' };
    const invalid = await f.drafts.changeAddress(token, seen, typed);
    expect(invalid).toMatchObject({ kind: 'open', problem: { kind: 'address', form: typed } });
    const problem = problemOf(invalid);
    expect(
      problem !== null && typeof problem === 'object' && problem.kind === 'address'
        ? problem.errors.map((error) => [error.field.join('.'), error.code])
        : problem,
    ).toEqual([
      ['phone', 'INVALID'],
      ['city', 'BLANK'],
    ]);

    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(
      await f.drafts.changeAddress(token, seen, { ...FORM, phone: '0300 1234567' }),
    ).toMatchObject({
      kind: 'open',
      problem: null,
      draft: {
        version: unaddressed.version + 2,
        phone: '+923001234567',
        shippingAddress: { city: 'Karachi', provinceCode: 'SD', phone: '+923001234567' },
      },
    });
    expect((await events()).map((event) => [event.event_type, event.payload])).toEqual([
      [
        'draft_order.updated',
        {
          changed: ['shippingAddress'],
          byCustomer: true,
          status: 'open',
          version: unaddressed.version + 2,
        },
      ],
    ]);

    // The page they saw before is stale. The number is the shop's now: another one is ignored.
    expect(problemOf(await f.drafts.changeAddress(token, seen, FORM))).toEqual({ kind: 'changed' });
    const corrected = { ...FORM, address2: 'Near Jamia Masjid', phone: '0345 7654321' };
    expect(await f.drafts.changeAddress(token, await shownOn(token), corrected)).toMatchObject({
      problem: null,
      draft: { phone: '+923001234567', shippingAddress: { address2: 'Near Jamia Masjid' } },
    });

    // Confirmed, it is an order, and the link corrects the order's address until it is packed.
    const confirmed = await f.drafts.confirmLink(token, await shownOn(token));
    if (confirmed.kind !== 'completed') throw new Error(`Expected an order, got ${confirmed.kind}`);
    expect(confirmed).toMatchObject({
      problem: null,
      order: { shippingAddress: { address2: 'Near Jamia Masjid' }, stage: 'to_pack' },
    });
    expect(
      await f.drafts.changeAddress(token, confirmed.shown, { ...FORM, city: 'lahore' }),
    ).toMatchObject({
      kind: 'completed',
      problem: null,
      order: { shippingAddress: { city: 'Lahore', provinceCode: 'PB' }, stage: 'to_pack' },
    });
    expect(
      (await f.orders.timeline(f.a, confirmed.order.id, { first: 1 })).items.map((entry) => [
        entry.kind,
        entry.actorKind,
        entry.message,
      ]),
    ).toEqual([
      ['updated', 'system', 'The customer changed the shipping address through their link'],
    ]);
    expect(problemOf(await f.drafts.changeAddress(token, confirmed.shown, FORM))).toEqual({
      kind: 'changed',
    });
    unwrap(await f.orders.markPacked(f.a, confirmed.order.id));
    expect(problemOf(await f.drafts.changeAddress(token, 'x', FORM))).toEqual({
      kind: 'too_late',
      action: 'address',
    });
  });

  it('shows the customer the order, their number masked, and nothing unescaped', async () => {
    await f.admin.query(`UPDATE control.shops SET name = 'Zari <Fashions>' WHERE id = $1`, [
      f.a.shopId,
    ]);
    const open = await draft({
      shippingAddress: { ...ADDRESS, name: 'Ayesha <b>Khan</b>' },
      discount: '100',
      advancePaid: '250',
    });
    const link = unwrap(await f.drafts.createLink(f.a, open.id));
    const view = await f.drafts.viewLink(tokenOf(link.url));
    const page = draftLinkPage(view);
    expect(page.status).toBe(200);
    expect(page.contentSecurityPolicy).toMatch(/^default-src 'none'; style-src 'sha256-/);
    expect(page.html).toContain('<title>Confirm your order · Zari &lt;Fashions&gt;</title>');
    expect(page.html).toContain('Ayesha &lt;b&gt;Khan&lt;/b&gt;');
    expect(page.html).not.toMatch(/<b>|<script/);
    expect(page.html).toContain('0300 ••••567');
    expect(page.html).not.toContain('1234567');
    const seen = (view as Extract<DraftLinkView, { kind: 'open' }>).shown;
    expect(page.html).toContain(`<input type="hidden" name="shown" value="${seen}" />`);
    for (const text of ['2 ×', 'Kurta', 'Rs 3,600', 'Rs 3,499', '-Rs 100', '-Rs 250', 'Rs 6,999']) {
      expect(page.html, text).toContain(text);
    }
    expect(page.html).toMatch(/This link works until \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} [ap]m\./);
    expect(page.html).toContain('<a href="?address">');

    const changed = draftLinkPage({
      ...(view as Extract<DraftLinkView, { kind: 'open' }>),
      problem: { kind: 'changed' },
    });
    expect(changed.status).toBe(409);
    expect(changed.html).toContain('This order changed after you opened it.');
    const unavailable = draftLinkPage({
      ...(view as Extract<DraftLinkView, { kind: 'open' }>),
      problem: { kind: 'unavailable', lines: [1] },
    });
    expect(unavailable.html).toContain('Sorry, Peshawari Chappal (9) can&#39;t be ordered now.');
    expect(draftLinkPage({ kind: 'not_found' }).status).toBe(404);
    expect(
      draftLinkPage({
        kind: 'expired',
        shop: { name: 'Zari', timezone: 'Asia/Karachi', accent: null, logo: null },
      }).status,
    ).toBe(410);

    const confirmed = draftLinkPage(await f.drafts.confirmLink(tokenOf(link.url), seen));
    expect(confirmed.status).toBe(200);
    expect(confirmed.html).toContain('Order confirmed');
    expect(confirmed.html).toContain('Your order #1001 is confirmed');
    expect(confirmed.html).toContain('You pay Rs 6,999 when it arrives.');
    expect(confirmed.html).toContain('Deliver to');
    expect(confirmed.html).not.toContain('name="shown"');
    // Placed, its address can still be corrected until it is packed.
    expect(confirmed.html).toContain('<a href="?address">');
  });

  it('keeps what the customer agreed to in confirming it, as checkout keeps it', async () => {
    const client = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Linux; Android 14)' };
    // A pair at a time, so that the stock lasts.
    const pair = () => draft({ lineItems: [{ variantId: size8, quantity: 1 }] });
    const open = async () => {
      const token = tokenOf(unwrap(await f.drafts.createLink(f.a, (await pair()).id)).url);
      const view = await f.drafts.viewLink(token);
      if (view.kind !== 'open') throw new Error(`Expected a draft, got ${view.kind}`);
      return { token, view };
    };
    const agreementOf = (view: DraftLinkView) => {
      if (view.kind !== 'completed') throw new Error(`Expected an order, got ${view.kind}`);
      return view.order.agreement;
    };

    // A shop without policies: the page names none, and the order keeps where it came from.
    const bare = await open();
    expect(bare.view.terms).toEqual([]);
    expect(draftLinkPage(bare.view).html).not.toContain('you agree to');
    expect(agreementOf(await f.drafts.confirmLink(bare.token, bare.view.shown, client))).toEqual({
      policyVersions: [],
      ...client,
    });

    // The page names the policies but the shop's contact information, which promises nothing,
    // each where the storefront shows it.
    await policy('contact_information', '<p>WhatsApp 0300 1234567</p>');
    const terms = await policy('terms_of_service', '<p>Orders are confirmed by phone.</p>');
    const refund = await policy('refund_policy', '<p>7 days.</p>');
    const { rows } = await f.admin.query<{ handle: string }>(
      'SELECT handle FROM control.shops WHERE id = $1',
      [f.a.shopId],
    );
    const storefront = `https://${rows[0]!.handle}.hatti.test`;
    const { token, view } = await open();
    expect(view.terms).toEqual([
      { type: 'refund_policy', versionId: refund, url: `${storefront}/policies/refund-policy` },
      {
        type: 'terms_of_service',
        versionId: terms,
        url: `${storefront}/policies/terms-of-service`,
      },
    ]);
    const page = draftLinkPage(view).html;
    expect(page).toContain(
      "By confirming your order, you agree to the shop's " +
        `<a href="${storefront}/policies/refund-policy" target="_blank" rel="noopener">` +
        'refund policy</a> and ' +
        `<a href="${storefront}/policies/terms-of-service" target="_blank" rel="noopener">` +
        'terms of service</a>.',
    );
    expect(page).toContain('آرڈر کنفرم کر کے آپ دکان کی ان پالیسیوں سے اتفاق کرتے ہیں:');

    // A policy changed while the page was open: the customer sees it again before confirming.
    const newRefund = await policy('refund_policy', '<p>14 days.</p>');
    const stale = await f.drafts.confirmLink(token, view.shown, client);
    expect(problemOf(stale)).toEqual({ kind: 'changed' });
    expect(draftLinkPage(stale).html).toContain(
      'This order or the shop&#39;s policies changed after you opened it.',
    );
    expect(await orderCount()).toBe(1);
    const confirmed = await f.drafts.confirmLink(token, await shownOn(token), client);
    expect(agreementOf(confirmed)).toEqual({ policyVersions: [newRefund, terms], ...client });
    // As checkout's, an address or browser that is not one is not kept.
    const odd = await open();
    expect(
      agreementOf(
        await f.drafts.confirmLink(odd.token, odd.view.shown, { ip: 'x', userAgent: '' }),
      ),
    ).toEqual({ policyVersions: [newRefund, terms], ip: null, userAgent: null });

    // A draft staff place for the customer, who agreed in the chat, keeps none.
    const completed = unwrap(await f.drafts.complete(f.a, (await pair()).id));
    expect((await f.orders.get(f.a, completed.orderId!))?.agreement).toBeNull();
  });

  it('asks for the address and number on the page of a draft without them', async () => {
    const unaddressed = await draft({ shippingAddress: null });
    const view = await f.drafts.viewLink(
      tokenOf(unwrap(await f.drafts.createLink(f.a, unaddressed.id)).url),
    );
    if (view.kind !== 'open') throw new Error(`Expected a draft, got ${view.kind}`);
    const page = draftLinkPage(view);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Add the address to deliver to, then confirm your order.');
    expect(page.html).toContain('<a class="button stack" href="?address">');
    expect(page.html).not.toContain('value="confirm"');

    const form = draftLinkPage(view, { form: 'address' });
    expect(form.status).toBe(200);
    expect(form.html).toContain('<title>Add your address · ');
    expect(form.html).toMatch(/name="phone"\s+type="tel" dir="ltr"\s+value=""/);
    expect(form.html).toContain('autocomplete="shipping tel"');
    expect(form.html).toContain('aria-describedby="phone-hint"');
    expect(form.html).toContain('The courier calls this number before delivering.');

    const typed = { ...FORM, phone: '0300 12' };
    const invalid = draftLinkPage(
      {
        ...view,
        problem: {
          kind: 'address',
          form: typed,
          errors: [{ field: ['phone'], code: 'INVALID', message: 'Phone must be a mobile number' }],
        },
      },
      { form: 'address' },
    );
    expect(invalid.status).toBe(422);
    expect(invalid.html).toContain('value="0300 12"');
    expect(invalid.html).toContain('aria-describedby="phone-hint phone-error"');
    expect(invalid.html).toContain('Enter a Pakistani mobile number, like 0300 1234567.');

    // Once the draft has a number, the form shows it masked and asks for no other.
    const addressed = await draft();
    const addressedView = await f.drafts.viewLink(
      tokenOf(unwrap(await f.drafts.createLink(f.a, addressed.id)).url),
    );
    const change = draftLinkPage(addressedView, { form: 'address' });
    expect(change.html).toContain('<title>Change the address · ');
    expect(change.html).toContain('value="House 12, Street 4, Block 5"');
    expect(change.html).toContain('0300 ••••567');
    expect(change.html).not.toContain('name="phone"');
  });

  it("goes when its customer's details are erased", async () => {
    // Another customer's draft stays.
    const other = await draft({ shippingAddress: { ...ADDRESS, phone: '0345 7654321' } });
    const open = await draft();
    const emailed = await draft({ shippingAddress: null, email: 'A@example.com' });
    // Placing it makes Ayesha a customer, with her email.
    const placed = unwrap(
      await f.drafts.complete(f.a, (await draft({ email: 'a@example.com' })).id),
    );
    const order = (await f.orders.get(f.a, placed.orderId!))!;
    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));

    unwrap(await f.customerData.erase(f.a, order.customerId));
    const { rows } = await f.admin.query<{ id: string }>('SELECT id FROM orders.draft_orders');
    expect(rows.map((row) => row.id)).toEqual([other.id]);
    expect(await f.drafts.get(f.a, open.id)).toBeNull();
    expect(await f.drafts.get(f.a, emailed.id)).toBeNull();
    expect((await f.orders.get(f.a, order.id))?.customerErasedAt).toBeInstanceOf(Date);
  });
});
