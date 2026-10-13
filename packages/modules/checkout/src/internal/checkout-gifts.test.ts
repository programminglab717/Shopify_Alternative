import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm } from './checkout.service.js';
import { GiftOptionsService } from './gift-options.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Gift wrap and gift messages at checkout (CHK-16, ADR-413)', () => {
  let f: CheckoutFixture;
  let gifts: GiftOptionsService;
  let kurta: string;
  let wrap: string;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
    gifts = new GiftOptionsService(f.db, f.variants);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [wrap] = (await f.variantsOf(f.a, 'Gift wrap', { price: '150' })) as [string];
    await f.stock(f.a, kurta, 100);
    await f.stock(f.a, wrap, 5);
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

  /** A checkout of a kurta: its secret and its page as it opens. */
  async function checkout() {
    const action = parseAction('add', { items: [{ variantId: kurta, quantity: 1 }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return { secret, view };
  }

  it('adds the shop’s gift wrap to the order at its price, and keeps a gift message', async () => {
    // Neither until the shop chooses: nothing on the page.
    const before = await checkout();
    expect(before.view.gift).toBeNull();
    expect(checkoutPage(before.view).html).not.toContain('gift');

    expect(unwrap(await gifts.update(f.a, { wrapVariantId: wrap, messages: true }))).toEqual({
      wrap: {
        variantId: wrap,
        productTitle: 'Gift wrap',
        variantTitle: 'Default Title',
        price: 150_00n,
        forSale: true,
      },
      messages: true,
    });
    const { secret, view } = await checkout();
    expect(view.gift).toEqual({
      wrap: { variantId: wrap, title: 'Gift wrap', price: 150_00n, added: false },
      messages: true,
    });
    const page = checkoutPage(view).html;
    expect(page).toContain('Have it gift-wrapped for Rs 150.');
    expect(page).toContain('value="gift_wrap"');
    expect(page).toContain('name="gift_message"');

    // Added: a line of the cart's, and the page's totals with it.
    const wrapped = await f.checkouts.giftWrap(secret, true);
    if (wrapped.kind !== 'open') throw new Error(`Expected it open, got ${wrapped.kind}`);
    expect(wrapped.gift?.wrap).toMatchObject({ added: true });
    expect(wrapped.cart.items.map((item) => [item.title, item.quantity])).toEqual([
      ['Gift wrap', 1],
      ['Kurta', 1],
    ]);
    expect(wrapped.cart.subtotal).toBe(2_150_00);
    expect(checkoutPage(wrapped).html).toContain('value="remove_gift_wrap"');
    // Asked again, it is still one.
    const again = await f.checkouts.giftWrap(secret, true);
    if (again.kind !== 'open') throw new Error(`Expected it open, got ${again.kind}`);
    expect(again.cart.items).toHaveLength(2);

    const placed = await f.checkouts.place(secret, again.shown, {
      ...FORM,
      giftMessage: '  Eid Mubarak, Ammi!  ',
    });
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(placed.order.giftMessage).toBe('Eid Mubarak, Ammi!');
    expect(placed.order.lines.map((line) => [line.title, line.total])).toEqual([
      ['Gift wrap', 150_00n],
      ['Kurta', 2_000_00n],
    ]);
  });

  it('takes the wrap off, offers none out of stock, and keeps no message the shop does not ask for', async () => {
    unwrap(await gifts.update(f.a, { wrapVariantId: wrap, messages: false }));
    const { secret } = await checkout();
    unwrap(await gifts.update(f.a, { wrapVariantId: wrap, messages: false }));
    await f.checkouts.giftWrap(secret, true);
    const off = await f.checkouts.giftWrap(secret, false);
    if (off.kind !== 'open') throw new Error(`Expected it open, got ${off.kind}`);
    expect(off.cart.items.map((item) => item.title)).toEqual(['Kurta']);
    expect(checkoutPage(off).html).not.toContain('name="gift_message"');

    const placed = await f.checkouts.place(secret, off.shown, { ...FORM, giftMessage: 'Hi' });
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(placed.order.giftMessage).toBeNull();

    // None left: not offered, nor a message, so nothing at all.
    await f.stock(f.a, wrap, 0);
    expect((await checkout()).view.gift).toBeNull();
  });

  it("refuses another shop's variant as its gift wrap, and records what changed", async () => {
    const [theirs] = (await f.variantsOf(f.b, 'Their wrap')) as [string];
    for (const variant of [theirs, newId()]) {
      const refused = await gifts.update(f.a, { wrapVariantId: variant, messages: true });
      expect(refused.ok ? [] : refused.errors.map((error) => [error.field, error.code])).toEqual([
        [['input', 'wrapVariantId'], 'NOT_FOUND'],
      ]);
    }
    unwrap(await gifts.update(f.a, { wrapVariantId: null, messages: true }));
    unwrap(await gifts.update(f.a, { wrapVariantId: null, messages: true }));
    expect(await gifts.get(f.a)).toEqual({ wrap: null, messages: true });
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'gift_options.updated')
        .map((event) => event.payload),
    ).toEqual([{ wrapVariantId: null, messages: true }]);
  });
});
