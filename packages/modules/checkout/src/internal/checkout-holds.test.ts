import 'reflect-metadata';
import { BundleService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm } from './checkout.service.js';
import { StockHoldService } from './stock-holds.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Stock held while a shopper checks out (CHK-02, ADR-715)', () => {
  let f: CheckoutFixture;
  let holds: StockHoldService;
  let kurta: string;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
    holds = new StockHoldService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 2);
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

  /** A cart of `quantity` of `variantId`, or why the cart refused it. */
  async function cartOf(variantId: string, quantity: number) {
    const action = parseAction('add', { items: [{ variantId, quantity }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    return f.carts.act(f.a.shopId, null, action);
  }

  /** A checkout of the cart `token` names: its secret and its page as it opens. */
  async function checkoutOf(token: string) {
    const secret = (await f.checkouts.start(f.a.shopId, token))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return { secret, view };
  }

  /** The kurta's stock at the shop's primary location. */
  async function level(variantId = kurta) {
    const { rows } = await f.admin.query<{ reserved: number; committed: number }>(
      `SELECT reserved, committed FROM inventory.levels WHERE variant_id = $1`,
      [variantId],
    );
    return rows[0];
  }

  /** What each checkout of the shop holds, oldest first. */
  async function held() {
    const { rows } = await f.admin.query<{ held: unknown; held_until: Date | null }>(
      `SELECT held, held_until FROM checkout.checkouts ORDER BY created_at, id`,
    );
    return rows;
  }

  it('keeps the minutes from 5 to 60, or none, and records their change', async () => {
    expect(await holds.get(f.a)).toBeNull();
    for (const minutes of [4, 61, 7.5]) {
      const refused = await holds.update(f.a, minutes);
      expect(refused).toMatchObject({
        ok: false,
        errors: [{ field: ['minutes'], code: 'INVALID' }],
      });
    }
    expect(unwrap(await holds.update(f.a, 15))).toBe(15);
    expect(unwrap(await holds.update(f.a, 15))).toBe(15);
    expect(await holds.get(f.a)).toBe(15);
    // The other shop holds none.
    expect(await holds.get(f.b)).toBeNull();
    expect(unwrap(await holds.update(f.a, null))).toBeNull();
    const events = (await f.outbox()).filter((event) => event.event_type === 'stock_hold.updated');
    expect(events.map((event) => event.payload)).toEqual([{ minutes: 15 }, { minutes: null }]);
  });

  it("holds the cart's stock from others while its shopper checks out, and the order takes it", async () => {
    unwrap(await holds.update(f.a, 15));
    const mine = await cartOf(kurta, 2);
    if (!mine.ok) throw new Error('Refused');
    const before = Date.now();
    const { secret, view } = await checkoutOf(mine.token!);
    expect(await level()).toEqual({ reserved: 2, committed: 0 });
    // Until 15 minutes on, which the page says.
    const until = view.heldUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + 15 * 60_000 - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000);
    expect(checkoutPage(view).html).toContain('Your items are held for you until');
    // The shopper's own cart counts them as theirs still; another's finds none left.
    expect((await f.carts.cart(f.a.shopId, mine.token!))!.items[0]!.maxQuantity).toBeNull();
    expect(view.cart.items[0]!.maxQuantity).toBeNull();
    const theirs = await cartOf(kurta, 1);
    expect(theirs.ok).toBe(false);

    const placed = await f.checkouts.place(secret, view.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(await level()).toEqual({ reserved: 0, committed: 2 });
    expect(await held()).toEqual([{ held: null, held_until: null }]);
  });

  it('gives back the hold of a checkout of the same cart begun again, and holds none unasked', async () => {
    const cart = await cartOf(kurta, 1);
    if (!cart.ok) throw new Error('Refused');
    // None until the shop asks.
    const unheld = await checkoutOf(cart.token!);
    expect(unheld.view.heldUntil).toBeUndefined();
    expect(checkoutPage(unheld.view).html).not.toContain('held for you');
    expect(await level()).toEqual({ reserved: 0, committed: 0 });

    unwrap(await holds.update(f.a, 10));
    await checkoutOf(cart.token!);
    await checkoutOf(cart.token!);
    // One hold, the last checkout's.
    expect(await level()).toEqual({ reserved: 1, committed: 0 });
    expect((await held()).map((row) => row.held !== null)).toEqual([false, false, true]);
    // The shop stops holding: a checkout begun again gives back the last, and holds none.
    unwrap(await holds.update(f.a, null));
    await checkoutOf(cart.token!);
    expect(await level()).toEqual({ reserved: 0, committed: 0 });
  });

  it('holds none when the stock is too short to hold it all, and checks it again on placing', async () => {
    unwrap(await holds.update(f.a, 10));
    const cart = await cartOf(kurta, 2);
    if (!cart.ok) throw new Error('Refused');
    await f.stock(f.a, kurta, 1);
    const { view } = await checkoutOf(cart.token!);
    expect(view.heldUntil).toBeUndefined();
    expect(await level()).toEqual({ reserved: 0, committed: 0 });
    expect(view.cart.items[0]!.maxQuantity).toBe(1);
  });

  it('keeps the hold when placing refuses the order', async () => {
    unwrap(await holds.update(f.a, 10));
    const cart = await cartOf(kurta, 2);
    if (!cart.ok) throw new Error('Refused');
    const { secret, view } = await checkoutOf(cart.token!);
    const placeIn = vi.spyOn(f.orders, 'placeIn').mockResolvedValueOnce({
      ok: false,
      errors: [{ field: [], code: 'OUT_OF_STOCK', message: 'Out of stock' }],
    });
    try {
      const refused = await f.checkouts.place(secret, view.shown, FORM);
      expect(refused).toMatchObject({ kind: 'open', problem: { kind: 'unavailable' } });
    } finally {
      placeIn.mockRestore();
    }
    // Given back in the savepoint, and taken again with it.
    expect(await level()).toEqual({ reserved: 2, committed: 0 });
    expect((await held())[0]!.held).not.toBeNull();
  });

  it('gives back holds whose minutes ran out when the sweep comes, before their checkout goes', async () => {
    unwrap(await holds.update(f.a, 10));
    const cart = await cartOf(kurta, 2);
    if (!cart.ok) throw new Error('Refused');
    const { secret } = await checkoutOf(cart.token!);
    // Not yet: its minutes have not run out.
    expect(await f.expiry.deleteExpired()).toMatchObject({ holds: 0 });
    expect(await level()).toEqual({ reserved: 2, committed: 0 });

    await f.admin.query(`UPDATE checkout.checkouts SET held_until = now() - interval '1 minute'`);
    // Its page says nothing of a hold past its minutes.
    const lapsed = await f.checkouts.view(secret);
    expect(lapsed).not.toHaveProperty('heldUntil');
    expect(await f.expiry.deleteExpired()).toMatchObject({ holds: 1, checkouts: 0 });
    expect(await level()).toEqual({ reserved: 0, committed: 0 });
    expect(await held()).toEqual([{ held: null, held_until: null }]);
    // Others may buy them now.
    expect((await cartOf(kurta, 2)).ok).toBe(true);

    // A checkout past its day that holds stock is deleted once the sweep gave it back.
    await checkoutOf(cart.token!);
    await f.admin.query(
      `UPDATE checkout.checkouts SET expires_at = now() - interval '1 minute',
                                     held_until = now() - interval '1 minute'
        WHERE held IS NOT NULL`,
    );
    expect(await f.expiry.deleteExpired()).toMatchObject({ holds: 1, checkouts: 1 });
    expect(await level()).toEqual({ reserved: 0, committed: 0 });
  });

  it('holds a bundle as its parts', async () => {
    unwrap(await holds.update(f.a, 10));
    const [dupatta] = (await f.variantsOf(f.a, 'Dupatta', { price: '500' })) as [string];
    await f.stock(f.a, dupatta, 4);
    const [suit] = (await f.variantsOf(f.a, 'Eid suit', { price: '2,300' })) as [string];
    const productId = (
      await f.db.tenant(f.a.shopId, (tx) => f.variants.snapshotsOf(tx, f.a.shopId, [suit]))
    ).get(suit)!.productId;
    unwrap(
      await new BundleService(f.db).set(f.a, productId, [
        { variantId: kurta, quantity: 1 },
        { variantId: dupatta, quantity: 2 },
      ]),
    );
    const cart = await cartOf(suit, 2);
    if (!cart.ok) throw new Error(`Refused: ${JSON.stringify(cart.error)}`);
    const { view } = await checkoutOf(cart.token!);
    expect(view.heldUntil).toBeDefined();
    expect(await level(kurta)).toEqual({ reserved: 2, committed: 0 });
    expect(await level(dupatta)).toEqual({ reserved: 4, committed: 0 });
    // The set is still the shopper's to buy.
    expect(view.cart.items[0]!.maxQuantity).toBeNull();
  });
});
