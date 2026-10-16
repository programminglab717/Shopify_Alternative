import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import type { CartActionName } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { CHECKOUT_CUSTOMER_DATA } from './customer-data.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

/** What the shopper typed before leaving: their name and number, no address yet. */
const TYPED: CheckoutForm = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  city: '',
  address1: '',
  address2: '',
  landmark: '',
  province: '',
  payment: '',
  code: '',
  resend: '',
};

const HOUR = 3_600_000;

describe.skipIf(!server)('Abandoned checkouts, their reminder and offer (CHK-12, ADR-393)', () => {
  let f: CheckoutFixture;
  let suit: string;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [suit] = (await f.variantsOf(f.a, 'Lawn 3-piece', { price: '4,500' })) as [string];
    await f.stock(f.a, suit, 10);
  });

  async function act(owner: TenantContext, name: CartActionName, body: unknown) {
    const action = parseAction(name, body);
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const result = await f.carts.act(owner.shopId, null, action);
    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    return result.token!;
  }

  /** A checkout of two lawn suits: its secret and page. */
  async function started() {
    const token = await act(f.a, 'add', { items: [{ variantId: suit, quantity: 2 }] });
    const secret = (await f.checkouts.start(f.a.shopId, token))!;
    return { secret, view: open(await f.checkouts.view(secret)) };
  }

  function open(view: CheckoutView) {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  }

  /** The reminder queued last: who it goes to, and its link. */
  async function reminders() {
    const { rows } = await f.admin.query<{ recipient: string; name: string; url: string }>(
      `SELECT recipient, variables ->> 'name' AS name, variables ->> 'url' AS url
         FROM messaging.messages WHERE kind = 'checkout_reminder' ORDER BY created_at`,
    );
    return rows;
  }

  it('keeps the number as the script sends it, or as the page is posted, for the shop to see', async () => {
    const { secret, view } = await started();
    expect(await f.abandoned.list(f.a)).toEqual([]);
    // Not a mobile: nothing kept.
    expect(await f.checkouts.keepContact(secret, { name: 'A', phone: '12345' })).toBe(false);
    expect(await f.checkouts.keepContact(secret, { name: 'Ayesha', phone: '0300 1234567' })).toBe(
      true,
    );
    // Another shop's secret is not this one's.
    expect(await f.checkouts.keepContact(secret, TYPED, f.b.shopId)).toBe(false);

    // Posted without an address: the page asks for it, and keeps the name typed.
    const posted = await f.checkouts.place(secret, view.shown, TYPED);
    expect(posted.kind === 'open' && posted.problem?.kind).toBe('address');
    const [left] = await f.abandoned.list(f.a);
    expect(left).toMatchObject({
      name: 'Ayesha Khan',
      phone: '+923001234567',
      lines: [{ variantId: suit, title: 'Lawn 3-piece', quantity: 2 }],
      subtotal: 9_000_00n,
      currency: 'PKR',
      remindedAt: null,
      recoveredOrder: null,
    });
    expect(await f.abandoned.list(f.b)).toEqual([]);

    // Placed after all: no longer abandoned.
    const placed = await f.checkouts.place(secret, view.shown, {
      ...TYPED,
      city: 'khi',
      address1: 'House 12, Street 4',
    });
    expect(placed.kind).toBe('placed');
    expect(await f.abandoned.list(f.a)).toEqual([]);
  });

  it('reminds once, as long after as the shop says, with a link back to the items', async () => {
    const { secret } = await started();
    await f.checkouts.keepContact(secret, { name: 'Ayesha', phone: '0300 1234567' });
    const later = (hours: number) => new Date(Date.now() + hours * HOUR);

    // Until the shop chooses, nobody is reminded.
    expect(await f.abandoned.settings(f.a)).toEqual({ reminderAfterMinutes: null, offer: null });
    expect(await f.abandoned.remindDue(later(2))).toBe(0);
    const refused = await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 45 });
    expect(!refused.ok && refused.errors.map((error) => [error.field, error.code])).toEqual([
      [['input', 'reminderAfterMinutes'], 'INVALID'],
    ]);
    unwrap(await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 60 }));
    const outbox = await f.admin.query(
      `SELECT payload FROM platform.outbox_events WHERE event_type = 'recovery_settings.updated'`,
    );
    expect(outbox.rows).toEqual([
      { payload: { reminderAfterMinutes: 60, offerCode: null, offerAfterHours: null } },
    ]);

    // Not yet an hour on; then once; and not more than a day on.
    expect(await f.abandoned.remindDue(later(0.5))).toBe(0);
    expect(await f.abandoned.remindDue(later(1.1))).toBe(1);
    expect(await f.abandoned.remindDue(later(1.2))).toBe(0);
    const [sent] = await reminders();
    expect(sent).toMatchObject({ recipient: '+923001234567', name: 'Ayesha' });
    expect(sent!.url).toMatch(/^https:\/\/hatti\.test\/r\/[A-Za-z0-9_-]{22}$/);
    const [left] = await f.abandoned.list(f.a);
    expect(left!.remindedAt).not.toBeNull();

    // The link: the shop's storefront, at a cart of the items left.
    const { rows } = await f.admin.query<{ handle: string }>(
      'SELECT handle FROM control.shops WHERE id = $1',
      [f.a.shopId],
    );
    const token = sent!.url.split('/').pop()!;
    expect(await f.abandoned.reminderTarget(token)).toBe(
      `https://${rows[0]!.handle}.hatti.test/cart/${suit}:2`,
    );
    expect(await f.abandoned.reminderTarget('x'.repeat(22))).toBeNull();
    expect(await f.abandoned.reminderTarget('../etc')).toBeNull();

    // Off again: the next shopper is not reminded.
    const next = await started();
    await f.checkouts.keepContact(next.secret, { name: '', phone: '0321 7654321' });
    unwrap(await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: null }));
    expect(await f.abandoned.remindDue(later(2))).toBe(0);
    // Left more than a day ago: not reminded once the shop turns it on.
    unwrap(await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 30 }));
    expect(await f.abandoned.remindDue(later(25))).toBe(0);
  });

  it("offers the shop's code some hours after the reminder, once, its link applying it (ADR-426)", async () => {
    const code = async (input: object) => unwrap(await f.codes.create(f.a, input as never));
    const eid = await code({ code: 'EID10', percentage: 10 });
    const free = await code({ code: 'FREESHIP', freeShipping: true });
    const big = await code({ code: 'BIG500', amount: '500', minimumSubtotal: '20,000' });
    const errors = async (input: Parameters<typeof f.abandoned.updateSettings>[1]) => {
      const result = await f.abandoned.updateSettings(f.a, input);
      return result.ok ? [] : result.errors.map((error) => [error.field.at(-1), error.code]);
    };
    // No offer without the reminder; a code of the shop's, not free delivery; 12, 24 or 48 hours.
    expect(await errors({ reminderAfterMinutes: null, offerCodeId: eid.id })).toEqual([
      ['offerCodeId', 'INVALID'],
    ]);
    expect(await errors({ reminderAfterMinutes: 60, offerCodeId: free.id })).toEqual([
      ['offerCodeId', 'INVALID'],
    ]);
    const other = unwrap(await f.codes.create(f.b, { code: 'B10', percentage: 10 }));
    expect(await errors({ reminderAfterMinutes: 60, offerCodeId: other.id })).toEqual([
      ['offerCodeId', 'NOT_FOUND'],
    ]);
    expect(
      await errors({ reminderAfterMinutes: 60, offerCodeId: eid.id, offerAfterHours: 6 }),
    ).toEqual([['offerAfterHours', 'INVALID']]);

    const set = unwrap(
      await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 60, offerCodeId: eid.id }),
    );
    expect(set).toMatchObject({ reminderAfterMinutes: 60, offer: { afterHours: 24 } });
    expect(set.offer!.code.code).toBe('EID10');
    // Left out, the offer stays as it is.
    unwrap(await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 30 }));
    expect((await f.abandoned.settings(f.a)).offer).toMatchObject({ afterHours: 24 });
    const { rows: events } = await f.admin.query<{ payload: object }>(
      `SELECT payload FROM platform.outbox_events WHERE event_type = 'recovery_settings.updated'
        ORDER BY occurred_at`,
    );
    expect(events.map((row) => row.payload)).toEqual([
      { reminderAfterMinutes: 60, offerCode: 'EID10', offerAfterHours: 24 },
      { reminderAfterMinutes: 30, offerCode: 'EID10', offerAfterHours: 24 },
    ]);

    const { secret } = await started();
    await f.checkouts.keepContact(secret, { name: 'Ayesha', phone: '0300 1234567' });
    const t0 = Date.now();
    const at = (hours: number) => new Date(t0 + hours * HOUR);
    expect(await f.abandoned.remindDue(at(1))).toBe(1);
    // Not before 24 hours after the reminder; then once.
    expect(await f.abandoned.offerDue(at(20))).toBe(0);
    expect(await f.abandoned.offerDue(at(25.1))).toBe(1);
    expect(await f.abandoned.offerDue(at(25.2))).toBe(0);
    const { rows: offers } = await f.admin.query<{
      recipient: string;
      variables: Record<string, string>;
    }>(`SELECT recipient, variables FROM messaging.messages WHERE kind = 'checkout_offer'`);
    expect(offers).toEqual([
      {
        recipient: '+923001234567',
        variables: {
          name: 'Ayesha',
          shop: expect.any(String),
          offer: '10%',
          discount: 'EID10',
          url: expect.stringMatching(/^https:\/\/hatti\.test\/r\/[A-Za-z0-9_-]{22}$/),
        },
      },
    ]);
    const [left] = await f.abandoned.list(f.a);
    expect(left).toMatchObject({ offerCode: 'EID10' });
    expect(left!.offeredAt).toEqual(at(25.1));

    // The offer's link opens the items with the code; the reminder's, still without.
    const { rows } = await f.admin.query<{ handle: string }>(
      'SELECT handle FROM control.shops WHERE id = $1',
      [f.a.shopId],
    );
    const cart = `https://${rows[0]!.handle}.hatti.test/cart/${suit}:2`;
    const offerToken = offers[0]!.variables.url!.split('/').pop()!;
    expect(await f.abandoned.reminderTarget(offerToken)).toBe(`${cart}?discount=EID10`);
    const [reminder] = await reminders();
    expect(await f.abandoned.reminderTarget(reminder!.url.split('/').pop()!)).toBe(cart);

    // A code the items come to too little for is not offered; nor once the code has expired.
    unwrap(
      await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 30, offerCodeId: big.id }),
    );
    const next = await started();
    await f.checkouts.keepContact(next.secret, { name: 'Bilal', phone: '0333 5556667' });
    expect(await f.abandoned.remindDue(at(1))).toBe(1);
    expect(await f.abandoned.offerDue(at(25.1))).toBe(0);
    unwrap(
      await f.abandoned.updateSettings(f.a, {
        reminderAfterMinutes: 30,
        offerCodeId: eid.id,
        offerAfterHours: 12,
      }),
    );
    await f.admin.query(`UPDATE pricing.discount_codes SET ends_at = now() WHERE id = $1`, [
      eid.id,
    ]);
    expect(await f.abandoned.offerDue(at(13.1))).toBe(0);
    await f.admin.query(`UPDATE pricing.discount_codes SET ends_at = NULL WHERE id = $1`, [eid.id]);
    expect(await f.abandoned.offerDue(at(13.1))).toBe(1);

    // The reminder turned off takes the offer with it; a code deleted offers nothing.
    unwrap(await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: null }));
    expect((await f.abandoned.settings(f.a)).offer).toBeNull();
    unwrap(
      await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 30, offerCodeId: eid.id }),
    );
    unwrap(await f.codes.delete(f.a, eid.id));
    expect(await f.abandoned.settings(f.a)).toEqual({ reminderAfterMinutes: 30, offer: null });
  });

  it('is offered no code once the number has ordered (ADR-426)', async () => {
    const eid = unwrap(await f.codes.create(f.a, { code: 'EID10', percentage: 10 }));
    unwrap(
      await f.abandoned.updateSettings(f.a, {
        reminderAfterMinutes: 30,
        offerCodeId: eid.id,
        offerAfterHours: 12,
      }),
    );
    const left = await started();
    await f.checkouts.keepContact(left.secret, { name: 'Bilal', phone: '0333 5556667' });
    const t0 = Date.now();
    expect(await f.abandoned.remindDue(new Date(t0 + HOUR))).toBe(1);
    const order = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: suit, quantity: 1 }],
        shippingAddress: { name: 'Bilal', phone: '0333 5556667', address1: 'House 3', city: 'lhr' },
      }),
    );
    expect(await f.abandoned.offerDue(new Date(t0 + 14 * HOUR))).toBe(0);
    expect((await f.abandoned.list(f.a))[0]).toMatchObject({
      offeredAt: null,
      recoveredOrder: { id: order.id },
    });
  });

  it('is recovered by an order the number places after the reminder, or before it', async () => {
    unwrap(await f.abandoned.updateSettings(f.a, { reminderAfterMinutes: 30 }));
    const first = await started();
    await f.checkouts.keepContact(first.secret, { name: 'Ayesha', phone: '0300 1234567' });
    expect(await f.abandoned.remindDue(new Date(Date.now() + HOUR))).toBe(1);

    // Back through the link: a new checkout, placed with the same number.
    const back = await started();
    const placed = await f.checkouts.place(back.secret, back.view.shown, {
      ...TYPED,
      city: 'khi',
      address1: 'House 12, Street 4',
    });
    if (placed.kind !== 'placed') throw new Error(`Expected a placed order, got ${placed.kind}`);
    const [recovered] = await f.abandoned.list(f.a);
    expect(recovered!.recoveredOrder).toEqual({
      id: placed.order.id,
      number: placed.order.number,
    });

    // Ordered before the reminder was due, by another way: not reminded, and recovered.
    const other = await started();
    await f.checkouts.keepContact(other.secret, { name: 'Bilal', phone: '0333 5556667' });
    const order = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: suit, quantity: 1 }],
        shippingAddress: {
          name: 'Bilal',
          phone: '0333 5556667',
          address1: 'House 3',
          city: 'lhr',
        },
      }),
    );
    expect(await f.abandoned.remindDue(new Date(Date.now() + HOUR))).toBe(0);
    const bilal = (await f.abandoned.list(f.a)).find((each) => each.name === 'Bilal');
    expect(bilal).toMatchObject({ remindedAt: null, recoveredOrder: { id: order.id } });
  });

  it('is kept past its page for the shop, and goes with its customer once erased', async () => {
    const kept = await started();
    await f.checkouts.keepContact(kept.secret, { name: 'Ayesha', phone: '0300 1234567' });
    const plain = await started();
    await f.admin.query(`UPDATE checkout.checkouts SET expires_at = now() - interval '1 minute'`);
    const swept = await f.expiry.deleteExpired(new Date());
    expect(swept.checkouts).toBe(1);
    expect((await f.checkouts.view(plain.secret)).kind).toBe('not_found');
    expect(await f.abandoned.list(f.a)).toHaveLength(1);

    // A customer erased: what they typed goes, and the checkout is swept as any other.
    await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.erase(
        tx,
        f.a.shopId,
        {
          id: '00000000-0000-0000-0000-000000000000',
          phones: ['+923001234567'],
        } as never,
        'system',
      ),
    );
    expect(await f.abandoned.list(f.a)).toEqual([]);
    expect((await f.expiry.deleteExpired(new Date())).checkouts).toBe(1);
  });
});
