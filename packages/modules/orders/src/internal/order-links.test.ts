import 'reflect-metadata';
import type { StaffRole, TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftLinkPage, orderLinkPage } from './link-pages.js';
import type { AddressForm } from './links.js';
import type { OrderLinkView } from './order-link.service.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

type Shown = Extract<OrderLinkView, { kind: 'order' }>;

describe.skipIf(!server)('Order links', () => {
  let f: OrdersFixture;
  let kurta: string;
  let size8: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [size8] = (await f.variantsOf(f.a, 'Peshawari Chappal', {
      sizes: ['8'],
      price: '3,499',
    })) as [string];
    for (const variant of [kurta, size8]) await f.stock(f.a, variant, 5);
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

  /** The secret at the end of a link. */
  const tokenOf = (url: string) => url.slice('https://hatti.test/o/'.length);

  /** A new link's secret. */
  const linkFor = async (orderId: string) =>
    tokenOf(unwrap(await f.links.createLink(f.a, orderId)).url);

  /** What a link shows, which must be an order. */
  const shownOn = async (token: string): Promise<Shown> => {
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    return view;
  };

  /** The order's events, without the catalog, stock and customer events around them. */
  const events = async () =>
    (await f.outbox()).filter((event) => event.event_type.startsWith('order.'));

  const latest = async (orderId: string) =>
    (await f.orders.timeline(f.a, orderId, { first: 1 })).items.map((entry) => [
      entry.kind,
      entry.actorKind,
      entry.message,
    ]);

  const messageOf = (whatsappUrl: string) => decodeURIComponent(whatsappUrl.split('?text=')[1]!);

  /** Why a link's action did not happen, if it did not. */
  const problemOf = (view: OrderLinkView) => (view.kind === 'order' ? view.problem : view.kind);

  /** An address as the customer might type it on their page. */
  const FORM: AddressForm = {
    name: 'Ayesha Khan',
    address1: 'Flat 3, Main Boulevard, Gulberg III',
    address2: '',
    landmark: '',
    city: 'lahore',
    province: '',
    zip: '',
    phone: '',
  };

  it("keeps how long the shop's customers may cancel, and who changed it", async () => {
    expect(await f.orderSettings.get(f.a)).toEqual({
      customerCancellation: 'until_packed',
      callingHours: null,
      firstCallMinutes: null,
      cancelUnreachableAfterDays: null,
      updatedAt: null,
    });
    await f.admin.query('DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log');
    const saved = unwrap(
      await f.orderSettings.update(f.a, { customerCancellation: 'until_confirmed' }),
    );
    expect(saved).toMatchObject({ customerCancellation: 'until_confirmed' });
    expect(saved.updatedAt).toBeInstanceOf(Date);
    // The same again, or nothing given, changes nothing.
    unwrap(await f.orderSettings.update(f.a, { customerCancellation: 'until_confirmed' }));
    unwrap(await f.orderSettings.update(f.a, {}));
    const appId = f.a.actor.kind === 'app' ? f.a.actor.tokenId : null;
    expect(
      (await f.outbox()).filter((event) => event.event_type === 'order_settings.updated'),
    ).toEqual([
      {
        event_type: 'order_settings.updated',
        aggregate_id: f.a.shopId,
        payload: {
          customerCancellation: 'until_confirmed',
          callingHours: null,
          firstCallMinutes: null,
          cancelUnreachableAfterDays: null,
          actorKind: 'app',
          actorId: appId,
        },
      },
    ]);
    const { rows } = await f.admin.query<{ action: string; details: unknown }>(
      'SELECT action, details FROM platform.audit_log',
    );
    expect(rows).toEqual([
      {
        action: 'order_settings.updated',
        details: {
          customerCancellation: 'until_confirmed',
          callingHours: null,
          firstCallMinutes: null,
          cancelUnreachableAfterDays: null,
        },
      },
    ]);
    expect(await f.orderSettings.get(f.b)).toMatchObject({ customerCancellation: 'until_packed' });
  });

  it('makes a link for an open order, and only for one', async () => {
    const order = await f.order(f.a, [kurta, size8], { shippingPrice: '250' });
    await f.admin.query('DELETE FROM platform.outbox_events');
    const link = unwrap(await f.links.createLink(staff('owner'), order.id));
    expect(link.url).toMatch(/^https:\/\/hatti\.test\/o\/[A-Za-z0-9_-]{22}$/);
    // It lasts: no expiry of its own while the order is open.
    expect(link.expiresAt).toBeNull();
    expect(link.order).toMatchObject({ link: { expiresAt: null }, version: order.version + 1 });
    expect(link.whatsappUrl).toMatch(/^https:\/\/wa\.me\/923001234567\?text=/);
    expect(messageOf(link.whatsappUrl)).toBe(
      `Please confirm your order #1001 from A:\n${link.url}\nاپنا آرڈر کنفرم کرنے کے لیے یہ لنک کھولیں۔`,
    );
    expect(await latest(order.id)).toEqual([
      ['link', 'staff', 'Made a link for the customer, working until 30 days after the order ends'],
    ]);
    expect((await events()).map((event) => [event.event_type, event.payload.changed])).toEqual([
      ['order.updated', ['link']],
    ]);

    // To a chat of the sender's choosing for staff who see numbers masked. A new link replaces
    // the old one.
    const before = Date.now();
    const second = unwrap(
      await f.links.createLink(staff('confirmation_agent'), order.id, { expiresInHours: 1 }),
    );
    expect(second.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(second.order.link).toEqual({ expiresAt: second.expiresAt });
    expect(second.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(await latest(order.id)).toEqual([
      ['link', 'staff', 'Made a link for the customer, working for 1 hour'],
    ]);
    expect(await f.links.viewLink(tokenOf(link.url))).toEqual({ kind: 'not_found' });
    expect(await shownOn(tokenOf(second.url))).toMatchObject({
      shop: { name: 'A', timezone: 'Asia/Karachi', accent: null, logo: null },
      order: { id: order.id },
      shown: expect.stringMatching(/^[\w-]{22}$/),
      problem: null,
    });
    for (const token of ['short', `${tokenOf(second.url)}x`]) {
      expect(await f.links.viewLink(token)).toEqual({ kind: 'not_found' });
      expect(await f.links.confirmLink(token, 'x')).toEqual({ kind: 'not_found' });
      expect(await f.links.cancelLink(token, 'x')).toEqual({ kind: 'not_found' });
      expect(await f.links.changeAddress(token, 'x', FORM)).toEqual({ kind: 'not_found' });
    }

    // A prepaid order waits for nobody: its link is for following it.
    const prepaid = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    const follow = unwrap(await f.links.createLink(f.a, prepaid.id));
    expect(messageOf(follow.whatsappUrl)).toMatch(/^Your order #1002 from A:\n/);

    // Not for a cancelled order, another shop's, or for longer than 30 days.
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    expect(errorsOf(await f.links.createLink(f.a, cancelled.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.links.createLink(f.b, order.id))).toEqual([['id', 'NOT_FOUND']]);
    for (const expiresInHours of [0, 721]) {
      expect(errorsOf(await f.links.createLink(f.a, order.id, { expiresInHours }))).toEqual([
        ['expiresInHours', 'INVALID'],
      ]);
    }
  });

  it('lets the customer confirm the order as the page showed it', async () => {
    const order = await f.order(f.a, [kurta, size8], { shippingPrice: '250' });
    const token = await linkFor(order.id);
    const seen = (await shownOn(token)).shown;

    // What the page does not show, such as a note or tags, may change; the address may not.
    unwrap(await f.orders.update(f.a, order.id, { note: 'Called once', tags: ['whatsapp'] }));
    expect((await shownOn(token)).shown).toBe(seen);
    unwrap(
      await f.orders.update(f.a, order.id, {
        shippingAddress: { ...ADDRESS, address1: 'House 14, Street 4' },
      }),
    );
    expect(await f.links.confirmLink(token, seen)).toMatchObject({
      kind: 'order',
      problem: { kind: 'changed' },
      order: { confirmationStatus: 'pending' },
    });

    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(await f.links.confirmLink(token, (await shownOn(token)).shown)).toMatchObject({
      kind: 'order',
      problem: null,
      order: { confirmationStatus: 'confirmed', stage: 'to_pack' },
    });
    expect((await f.orders.get(f.a, order.id))?.confirmedAt).toBeInstanceOf(Date);
    expect(await latest(order.id)).toEqual([
      ['confirmed', 'system', 'Confirmed by the customer through their link'],
    ]);

    // Once confirmed, the page shows the order as it is, and confirming again changes nothing.
    expect(await f.links.confirmLink(token, 'stale')).toMatchObject({
      problem: null,
      order: { confirmationStatus: 'confirmed' },
    });
    expect((await events()).map((event) => event.event_type)).toEqual(['order.confirmed']);
  });

  it('lets the customer cancel while the order waits for them', async () => {
    const order = await f.order(f.a, [kurta, size8]);
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 1, available: 4 });
    const token = await linkFor(order.id);
    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(await f.links.cancelLink(token, (await shownOn(token)).shown)).toMatchObject({
      kind: 'order',
      problem: null,
      order: {
        status: 'cancelled',
        cancelReason: 'customer',
        confirmationStatus: 'rejected',
        stage: 'cancelled',
      },
    });
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 0, available: 5 });
    expect(await latest(order.id)).toEqual([
      ['cancelled', 'system', 'Cancelled by the customer through their link'],
    ]);
    expect((await events()).map((event) => [event.event_type, event.payload.reason])).toEqual([
      ['order.cancelled', 'customer'],
    ]);
    // Cancelling again changes nothing, and a cancelled order is not confirmed.
    expect(await f.links.cancelLink(token, 'x')).toMatchObject({
      problem: null,
      order: { status: 'cancelled' },
    });
    expect(await f.links.confirmLink(token, 'x')).toMatchObject({
      problem: null,
      order: { status: 'cancelled', confirmationStatus: 'rejected' },
    });

    // In a shop whose customers cancel only until they confirm, an order the shop confirmed
    // after the customer opened the page can no longer be cancelled here.
    unwrap(await f.orderSettings.update(f.a, { customerCancellation: 'until_confirmed' }));
    const other = await f.order(f.a, [size8]);
    const otherToken = await linkFor(other.id);
    const seen = (await shownOn(otherToken)).shown;
    unwrap(await f.orders.confirm(f.a, other.id));
    expect(await shownOn(otherToken)).toMatchObject({ cancellable: false });
    expect(await f.links.cancelLink(otherToken, seen)).toMatchObject({
      problem: { kind: 'too_late', action: 'cancel' },
      order: { status: 'open', confirmationStatus: 'confirmed' },
    });
  });

  it('lets the customer cancel after confirming, until the order is packed, as the shop allows', async () => {
    const order = await f.order(f.a, [kurta]);
    const token = await linkFor(order.id);
    await f.links.confirmLink(token, (await shownOn(token)).shown);
    expect(await shownOn(token)).toMatchObject({
      cancellable: true,
      order: { confirmationStatus: 'confirmed', stage: 'to_pack' },
    });
    expect(orderLinkPage(await shownOn(token)).html).toContain('href="?cancel"');
    expect(orderLinkPage(await shownOn(token), { form: 'cancel' }).html).toContain(
      'name="action" value="cancel"',
    );

    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(await f.links.cancelLink(token, (await shownOn(token)).shown)).toMatchObject({
      problem: null,
      // They confirmed it, and then changed their mind.
      order: { status: 'cancelled', cancelReason: 'customer', confirmationStatus: 'confirmed' },
    });
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 0, available: 5 });
    expect(await latest(order.id)).toEqual([
      ['cancelled', 'system', 'Cancelled by the customer through their link, after confirming it'],
    ]);
    expect((await events()).map((event) => [event.event_type, event.payload.reason])).toEqual([
      ['order.cancelled', 'customer'],
    ]);

    // Packed, paid or shipped, it is the shop's to cancel.
    const packed = await f.order(f.a, [kurta]);
    const packedToken = await linkFor(packed.id);
    unwrap(await f.orders.confirm(f.a, packed.id));
    unwrap(await f.orders.markPacked(f.a, packed.id));
    expect(await shownOn(packedToken)).toMatchObject({ cancellable: false });
    expect(orderLinkPage(await shownOn(packedToken)).html).not.toContain('href="?cancel"');
    expect(orderLinkPage(await shownOn(packedToken), { form: 'cancel' }).html).not.toContain(
      'value="cancel"',
    );
    expect(await f.links.cancelLink(packedToken, (await shownOn(packedToken)).shown)).toMatchObject(
      {
        problem: { kind: 'too_late', action: 'cancel' },
        order: { status: 'open' },
      },
    );
    const paid = await f.order(f.a, [kurta]);
    unwrap(await f.orders.confirm(f.a, paid.id));
    unwrap(await f.orders.markAsPaid(f.a, paid.id));
    expect(await shownOn(await linkFor(paid.id))).toMatchObject({ cancellable: false });
  });

  it('lets the customer correct the address until the order is packed', async () => {
    const order = await f.order(f.a, [kurta, size8]);
    const token = await linkFor(order.id);
    const seen = (await shownOn(token)).shown;

    // An address that does not check out comes back as typed, with what is wrong.
    const typed = { ...FORM, name: ' ', city: '', zip: '5400' };
    const invalid = await f.links.changeAddress(token, seen, typed);
    expect(invalid).toMatchObject({
      kind: 'order',
      problem: { kind: 'address', form: typed },
      order: { version: order.version + 1, shippingAddress: { city: 'Karachi' } },
    });
    const problem = problemOf(invalid);
    expect(
      problem !== null && typeof problem === 'object' && problem.kind === 'address'
        ? problem.errors.map((error) => [error.field.join('.'), error.code])
        : problem,
    ).toEqual([
      ['name', 'BLANK'],
      ['city', 'BLANK'],
      ['zip', 'INVALID'],
    ]);

    // Their number stays; the province comes from the city.
    await f.admin.query('DELETE FROM platform.outbox_events');
    const withLandmark = { ...FORM, address2: 'Gulberg', landmark: ' Opposite Liberty Market ' };
    expect(await f.links.changeAddress(token, seen, withLandmark)).toMatchObject({
      kind: 'order',
      problem: null,
      order: {
        phone: '+923001234567',
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '+923001234567',
          address1: 'Flat 3, Main Boulevard, Gulberg III',
          address2: 'Gulberg',
          landmark: 'Opposite Liberty Market',
          city: 'Lahore',
          provinceCode: 'PB',
          zip: null,
        },
        confirmationStatus: 'pending',
      },
    });
    expect(await latest(order.id)).toEqual([
      ['updated', 'system', 'The customer changed the shipping address through their link'],
    ]);
    expect((await events()).map((event) => [event.event_type, event.payload.changed])).toEqual([
      ['order.updated', ['shippingAddress']],
    ]);

    // The address is part of what the customer confirms: the page they saw before is stale.
    expect(problemOf(await f.links.confirmLink(token, seen))).toEqual({ kind: 'changed' });
    expect(problemOf(await f.links.changeAddress(token, seen, FORM))).toEqual({ kind: 'changed' });
    expect(await f.links.confirmLink(token, (await shownOn(token)).shown)).toMatchObject({
      problem: null,
      order: { stage: 'to_pack' },
    });

    // Confirmed, the order can still be corrected, and stays confirmed. A province given stays,
    // for towns Hatti does not know; the same address again changes nothing.
    const town = { ...FORM, city: 'Chak 45', province: 'PB', zip: '38000' };
    expect(await f.links.changeAddress(token, (await shownOn(token)).shown, town)).toMatchObject({
      problem: null,
      order: {
        stage: 'to_pack',
        shippingAddress: { city: 'Chak 45', provinceCode: 'PB', zip: '38000' },
      },
    });
    const { version } = (await shownOn(token)).order;
    expect(await f.links.changeAddress(token, (await shownOn(token)).shown, town)).toMatchObject({
      problem: null,
      order: { version },
    });

    // Once packed, the parcel may carry the address on its slip: it is for the shop now.
    unwrap(await f.orders.markPacked(f.a, order.id));
    expect(await f.links.changeAddress(token, (await shownOn(token)).shown, FORM)).toMatchObject({
      problem: { kind: 'too_late', action: 'address' },
      order: { stage: 'to_book', shippingAddress: { city: 'Chak 45' } },
    });
    const cancelled = await f.order(f.a, [kurta]);
    const cancelledToken = await linkFor(cancelled.id);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    expect(problemOf(await f.links.changeAddress(cancelledToken, 'x', FORM))).toEqual({
      kind: 'too_late',
      action: 'address',
    });
  });

  it('shows how the order is doing, and nothing once expired or erased', async () => {
    const order = await f.order(f.a, [kurta]);
    const token = await linkFor(order.id);
    unwrap(await f.orders.confirm(f.a, order.id));
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, {
        tracking: {
          company: 'TCS',
          number: '779012345678',
          url: 'https://www.tcsexpress.com/track/779012345678',
        },
      }),
    );
    const shipped = orderLinkPage(await f.links.viewLink(token));
    expect(shipped.status).toBe(200);
    expect(shipped.html).toContain('On its way');
    expect(shipped.html).toContain('TCS 779012345678');
    expect(shipped.html).toContain('<a href="https://www.tcsexpress.com/track/779012345678">');
    expect(shipped.html).toContain('You pay Rs 2,000 when it arrives.');
    expect(shipped.html).not.toContain('<form');
    unwrap(await f.fulfillments.markDelivered(f.a, fulfillmentId));
    const delivered = orderLinkPage(await f.links.viewLink(token));
    expect(delivered.html).toContain('Your order #1001 was delivered.');
    expect(delivered.html).not.toContain('You pay');

    // An expired link shows nothing of the order.
    await f.admin.query(
      `UPDATE orders.orders SET link_expires_at = now() - interval '1 second' WHERE id = $1`,
      [order.id],
    );
    expect(await f.links.viewLink(token)).toEqual({
      kind: 'expired',
      shop: { name: 'A', timezone: 'Asia/Karachi', accent: null, logo: null },
    });

    // Erasing the customer's details takes the link with them.
    const other = await f.order(f.a, [size8], {
      shippingAddress: { ...ADDRESS, phone: '0345 7654321' },
    });
    const otherToken = await linkFor(other.id);
    unwrap(await f.orders.cancel(f.a, other.id, { reason: 'customer' }));
    unwrap(await f.customerData.erase(f.a, other.customerId));
    expect(await f.links.viewLink(otherToken)).toEqual({ kind: 'not_found' });
    expect((await f.orders.get(f.a, other.id))?.link).toBeNull();
  });

  it('keeps a link working until 30 days after its order ends, however long it takes', async () => {
    const DAY = 86_400_000;
    const order = await f.order(f.a, [kurta]);
    const token = await linkFor(order.id);
    const ago = (days: number, column: string) =>
      f.admin.query(
        `UPDATE orders.orders SET ${column} = now() - make_interval(secs => $2) WHERE id = $1`,
        [order.id, days * 86_400],
      );
    // An order open for months still has its link.
    await ago(120, 'created_at');
    expect((await f.links.viewLink(token)).kind).toBe('order');

    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    let ended = (await f.orders.get(f.a, order.id))!;
    expect(ended.link?.expiresAt).toEqual(new Date(ended.cancelledAt!.getTime() + 30 * DAY));
    await ago(29, 'cancelled_at');
    expect(orderLinkPage(await f.links.viewLink(token)).html).toContain('was cancelled');
    await ago(30.001, 'cancelled_at');
    expect(await f.links.viewLink(token)).toEqual({
      kind: 'expired',
      shop: { name: 'A', timezone: 'Asia/Karachi', accent: null, logo: null },
    });

    // A link made to expire keeps its expiry, unless the order ended more than 30 days before.
    const other = await f.order(f.a, [kurta]);
    const short = unwrap(await f.links.createLink(f.a, other.id, { expiresInHours: 720 }));
    unwrap(await f.orders.cancel(f.a, other.id, { reason: 'customer' }));
    ended = (await f.orders.get(f.a, other.id))!;
    expect(ended.link?.expiresAt).toEqual(short.expiresAt);
    await f.admin.query(
      `UPDATE orders.orders SET cancelled_at = now() - interval '10 days' WHERE id = $1`,
      [other.id],
    );
    ended = (await f.orders.get(f.a, other.id))!;
    expect(ended.link?.expiresAt).toEqual(new Date(ended.cancelledAt!.getTime() + 30 * DAY));
  });

  it("is in the shop's colour, with its logo, as its checkout's page is, a draft's too", async () => {
    // The colour of the shop's theme, and its logo: one of its files.
    await f.admin.query(
      `WITH theme AS (
         INSERT INTO online_store.themes (shop_id, name, base, role)
         VALUES ($1, 'Hatti Base', 'hatti-base', 'main') RETURNING shop_id, id)
       INSERT INTO online_store.theme_files (shop_id, theme_id, filename, body)
       SELECT shop_id, id, 'config/settings_data.json', $2 FROM theme`,
      [f.a.shopId, JSON.stringify({ current: { color_accent: '#B45309' } })],
    );
    const fileId = newId();
    const key = `shops/${f.a.shopId}/files/${fileId}/Zari.png`;
    await f.admin.query(
      `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status)
       VALUES ($1, $2, $3, 'Zari.png', 'image/png', 64, 'ready')`,
      [f.a.shopId, fileId, key],
    );
    await f.admin.query('INSERT INTO files.brands (shop_id, logo_file_id) VALUES ($1, $2)', [
      f.a.shopId,
      fileId,
    ]);
    const order = await f.order(f.a, [kurta]);
    const view = await shownOn(await linkFor(order.id));
    expect(view.shop).toEqual({
      name: 'A',
      timezone: 'Asia/Karachi',
      accent: '#B45309',
      logo: expect.stringMatching(`^https://hatti.test/storage/${key}\\?expires=\\d+&signature=`),
    });
    const page = orderLinkPage(view);
    expect(page.html).toContain('--accent: #B45309;');
    expect(page.html).toMatch(
      /<p class="shop"><img class="logo" src="https:\/\/hatti\.test\/storage\/[^"]+" alt="A" \/><\/p>/,
    );
    expect(page.contentSecurityPolicy).toContain(`; img-src https://hatti.test/storage/${key};`);
    expect(page.contentSecurityPolicy.match(/'sha256-/g)).toHaveLength(2);

    const draft = unwrap(
      await f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: ADDRESS,
      }),
    );
    const draftLink = unwrap(await f.drafts.createLink(f.a, draft.id)).url;
    const draftView = await f.drafts.viewLink(draftLink.slice('https://hatti.test/d/'.length));
    expect(draftView.kind === 'open' && draftView.shop).toMatchObject({
      accent: '#B45309',
      logo: expect.stringContaining(key),
    });
    expect(draftLinkPage(draftView).contentSecurityPolicy).toContain(
      `; img-src https://hatti.test/storage/${key};`,
    );

    // Without a logo, the shop's name, and no images.
    await f.admin.query('DELETE FROM files.brands');
    const plain = orderLinkPage(await shownOn(await linkFor(order.id)));
    expect(plain.html).toContain('<p class="shop"><bdi>A</bdi></p>');
    expect(plain.contentSecurityPolicy).not.toContain('img-src');
  });

  it('shows the order to confirm or cancel, with what people typed escaped', async () => {
    await f.admin.query(`UPDATE control.shops SET name = 'Zari <Fashions>' WHERE id = $1`, [
      f.a.shopId,
    ]);
    const order = await f.order(f.a, [kurta, size8], {
      shippingAddress: { ...ADDRESS, name: 'Ayesha <b>Khan</b>' },
      shippingPrice: '250',
      advancePaid: '250',
    });
    const view = await shownOn(await linkFor(order.id));
    const page = orderLinkPage(view);
    expect(page.status).toBe(200);
    expect(page.contentSecurityPolicy).toMatch(/^default-src 'none'; style-src 'sha256-/);
    expect(page.html).toContain('<title>Confirm your order · Zari &lt;Fashions&gt;</title>');
    expect(page.html).toContain('#1001');
    expect(page.html).toContain('Ayesha &lt;b&gt;Khan&lt;/b&gt;');
    expect(page.html).not.toMatch(/<b>|<script/);
    expect(page.html).toContain('0300 ••••567');
    expect(page.html).not.toContain('1234567');
    expect(page.html).toContain(`<input type="hidden" name="shown" value="${view.shown}" />`);
    expect(page.html).toContain('name="action" value="confirm"');
    expect(page.html).toContain('<a href="?cancel">');
    for (const text of ['Rs 5,749', '-Rs 250', 'Rs 5,499']) expect(page.html, text).toContain(text);
    // A link that lasts has no date to show; it asks the customer to keep it instead.
    expect(page.html).toContain('Keep this link: it shows where your order is until it arrives.');
    expect(page.html).not.toContain('This link works until');

    const asking = orderLinkPage(view, { form: 'cancel' });
    expect(asking.status).toBe(200);
    expect(asking.html).toContain('Cancel your order?');
    expect(asking.html).toContain(
      'Order #1001 will be cancelled, and nothing will be sent to you.',
    );
    expect(asking.html).toContain('name="action" value="cancel"');
    expect(asking.html).toContain(`name="shown" value="${view.shown}"`);
    expect(asking.html).toContain('<a href="?">');

    const changed = orderLinkPage({ ...view, problem: { kind: 'changed' } });
    expect(changed.status).toBe(409);
    expect(changed.html).toContain('This order changed after you opened it.');

    // Past waiting for the customer, the page says where the order is.
    const at = (changes: Partial<Shown['order']>, problem: Shown['problem'] = null) =>
      orderLinkPage({ ...view, order: { ...view.order, ...changes }, problem });
    const confirmed = { confirmationStatus: 'confirmed', stage: 'to_pack' } as const;
    expect(at(confirmed).html).toContain('Your order #1001 is confirmed');
    expect(at(confirmed, { kind: 'too_late', action: 'cancel' }).status).toBe(409);
    expect(at(confirmed, { kind: 'too_late', action: 'cancel' }).html).toContain(
      'This order can&#39;t be cancelled here any more.',
    );
    expect(at({ confirmationStatus: 'needs_review', stage: 'needs_review' }).html).toContain(
      'will be in touch before sending it',
    );
    expect(at({ status: 'cancelled', stage: 'cancelled' }).html).toContain('Order cancelled');
    expect(
      at({ confirmationStatus: 'confirmed', fulfillmentStatus: 'fulfilled', stage: 'returning' })
        .html,
    ).toContain('was not delivered and is going back');
    const lost = at({
      confirmationStatus: 'confirmed',
      fulfillmentStatus: 'fulfilled',
      stage: 'lost',
    });
    expect(lost.html).toContain('Not delivered');
    expect(lost.html).toContain('could not be delivered: the courier lost the parcel.');
  });

  it('shows the address to correct, as it is or as the customer typed it', async () => {
    const order = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, name: 'Ayesha "Ash" <Khan>' },
    });
    const view = await shownOn(await linkFor(order.id));
    expect(orderLinkPage(view).html).toContain('<a href="?address">');

    const page = orderLinkPage(view, { form: 'address' });
    expect(page.status).toBe(200);
    expect(page.html).toContain('<title>Change the address · ');
    expect(page.html).toContain('value="Ayesha &quot;Ash&quot; &lt;Khan&gt;"');
    expect(page.html).toContain('value="House 12, Street 4, Block 5"');
    expect(page.html).toContain('autocomplete="shipping address-line1"');
    expect(page.html).toContain('name="action" value="address"');
    expect(page.html).toContain(`name="shown" value="${view.shown}"`);
    expect(page.html).toContain('0300 ••••567');
    expect(page.html).not.toContain('1234567');
    expect(page.html).not.toMatch(/<input[^>]*aria-invalid/);
    // The area and the landmark in boxes of their own, the city's areas suggested for the area.
    expect(page.html).toMatch(/name="address2"[^>]*value="Gulshan-e-Iqbal"[^>]*list="areas"/);
    expect(page.html).toContain('<option value="Clifton"></option>');
    expect(page.html).not.toContain('label="Karachi"');
    expect(page.html).toMatch(/name="landmark"[^>]*value="Near Jamia Masjid"/);
    expect(page.html).toContain('A mosque, school or shop near you that the rider can ask for.');
    // Karachi's own province is left to the city, so that a new city brings its own.
    expect(page.html).toMatch(/<option value="" selected>\s*From the city/);
    expect(page.html).not.toMatch(/value="SD" selected/);
    expect(page.html).toContain('<a href="?">');

    const typed: AddressForm = {
      name: '',
      address1: 'Flat <3>',
      address2: '',
      landmark: '',
      city: 'Chak 45',
      province: 'PB',
      zip: '54',
      phone: '',
    };
    const invalid = orderLinkPage(
      {
        ...view,
        problem: {
          kind: 'address',
          form: typed,
          errors: [
            { field: ['name'], code: 'BLANK', message: "Name can't be blank" },
            { field: ['zip'], code: 'INVALID', message: 'Zip must be a five-digit postcode' },
          ],
        },
      },
      { form: 'address' },
    );
    expect(invalid.status).toBe(422);
    expect(invalid.html).toContain('Some of the address is missing or not right.');
    expect(invalid.html).toContain('Enter the name of who receives the parcel.');
    expect(invalid.html).toContain('A postcode has five digits, like 54000.');
    expect(invalid.html).toMatch(/aria-invalid="true"\s+aria-describedby="name-error"/);
    expect(invalid.html).toContain('<div id="name-error">');
    expect(invalid.html).toContain('value="Flat &lt;3&gt;"');
    expect(invalid.html).toMatch(/<option value="PB" selected>/);

    const changed = orderLinkPage({ ...view, problem: { kind: 'changed' } }, { form: 'address' });
    expect(changed.status).toBe(409);
    expect(changed.html).toContain('Check the address again, then save it.');
    expect(changed.html).toContain('value="House 12, Street 4, Block 5"');

    const saved = orderLinkPage(view, { saved: true });
    expect(saved.html).toContain('<div class="banner done" role="status">');
    expect(saved.html).toContain('Your new address is saved.');

    // Confirmed, the address can still be changed; packed, it is shown but not offered, and its
    // form shows the order instead.
    const at = (changes: Partial<Shown['order']>) => ({
      ...view,
      order: { ...view.order, confirmationStatus: 'confirmed', ...changes } as Shown['order'],
    });
    expect(orderLinkPage(at({ stage: 'to_pack' })).html).toContain('<a href="?address">');
    const packed = orderLinkPage(at({ stage: 'to_book', packedAt: new Date() }), {
      form: 'address',
    });
    expect(packed.status).toBe(200);
    expect(packed.html).toContain('Order confirmed');
    expect(packed.html).toContain('House 12, Street 4, Block 5');
    expect(packed.html).not.toContain('?address');
    expect(packed.html).not.toContain('<form');
    const tooLate = orderLinkPage(
      {
        ...at({ stage: 'to_book', packedAt: new Date() }),
        problem: { kind: 'too_late', action: 'address' },
      },
      { form: 'address' },
    );
    expect(tooLate.status).toBe(409);
    expect(tooLate.html).toContain('The address can&#39;t be changed here any more.');
  });
});
