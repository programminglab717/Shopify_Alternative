import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Delivery time slots chosen at checkout (CHK-15, ADR-769)', () => {
  let f: CheckoutFixture;
  let cake: string;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [cake] = (await f.variantsOf(f.a, 'Chocolate cake', { price: '2,500' })) as [string];
    await f.stock(f.a, cake, 100);
  });

  const FORM: CheckoutForm = {
    name: 'Ayesha Khan',
    phone: '0300-1234567',
    city: 'Lahore',
    address1: 'House 12, Street 4',
    address2: '',
    landmark: '',
    province: '',
    payment: '',
    code: '',
    resend: '',
  };

  /** A checkout of a cake: its secret and its page as it opens. */
  async function checkout() {
    const action = parseAction('add', { items: [{ variantId: cake, quantity: 1 }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return { secret, view };
  }

  it('asks for a time to deliver in, refuses none or one not offered, and keeps the one chosen', async () => {
    // A slot all day long, on three days: today's has begun, so tomorrow's comes first.
    unwrap(
      await f.delivery.update(f.a, {
        slots: [{ from: '00:00', until: '23:59' }],
        slotDays: 3,
        slotLeadHours: 0,
      }),
    );
    const { secret, view } = await checkout();
    expect(view.deliverySlots.map((slot) => slot.key.slice(10))).toEqual([
      'T00:00-23:59',
      'T00:00-23:59',
    ]);
    const [first, second] = view.deliverySlots;
    const page = checkoutPage(view).html;
    expect(page).toContain('name="delivery_slot"');
    expect(page).toContain(`value="${first!.key}"`);
    expect(page).toContain('00:00 – 23:59');

    // None chosen, or one the page did not offer: asked again, nothing placed.
    for (const deliverySlot of ['', '2020-01-01T00:00-23:59']) {
      const refused = await f.checkouts.place(secret, view.shown, { ...FORM, deliverySlot });
      if (refused.kind !== 'open') throw new Error(`Expected it open, got ${refused.kind}`);
      expect(refused.problem).toEqual({ kind: 'delivery_slot' });
      expect(checkoutPage(refused).html).toContain('Choose a time to have your order delivered');
    }

    const placed = await f.checkouts.place(secret, view.shown, {
      ...FORM,
      deliverySlot: second!.key,
    });
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(placed.order.deliverySlot).toEqual({
      startsAt: second!.startsAt,
      endsAt: second!.endsAt,
    });
    // Expected on the slot's day, not by the shop's working days.
    expect(placed.order.deliveryExpectedOn).toBe(second!.day);
    const { rows } = await f.admin.query<{ starts: string; ends: string }>(
      `SELECT to_char(delivery_slot_starts_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD"T"HH24:MI') AS starts,
              to_char(delivery_slot_ends_at AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS ends
         FROM orders.orders`,
    );
    expect(rows).toEqual([{ starts: `${second!.day}T00:00`, ends: '23:59' }]);
  });

  it('asks nothing where the shop offers no slots, or none far enough ahead', async () => {
    const plain = await checkout();
    expect(plain.view.deliverySlots).toEqual([]);
    expect(checkoutPage(plain.view).html).not.toContain('name="delivery_slot"');
    const placed = await f.checkouts.place(plain.secret, plain.view.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(placed.order.deliverySlot).toBeNull();

    // Today alone, from three days ahead: none is offered, so none is asked for.
    unwrap(
      await f.delivery.update(f.a, {
        slots: [{ from: '10:00', until: '13:00' }],
        slotDays: 1,
        slotLeadHours: 72,
      }),
    );
    const late = await checkout();
    expect(late.view.deliverySlots).toEqual([]);
    const unslotted = await f.checkouts.place(late.secret, late.view.shown, {
      ...FORM,
      phone: '0300-7654321',
    });
    if (unslotted.kind !== 'placed') throw new Error(`Expected it placed, got ${unslotted.kind}`);
    expect(unslotted.order.deliverySlot).toBeNull();
  });
});
