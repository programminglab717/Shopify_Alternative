import 'reflect-metadata';
import { GiftCardService } from '@hatti/customers/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import { GIFT_CARD_ATTEMPTS, type CheckoutForm, type CheckoutView } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Gift cards at checkout (PAY-13, ADR-449)', () => {
  let f: CheckoutFixture;
  let kurta: string;
  let cards: GiftCardService;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
    cards = new GiftCardService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
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

  /** A checkout of `quantity` kurtas at Rs 2,000: its secret. */
  async function checkout(quantity = 1) {
    const action = parseAction('add', { items: [{ variantId: kurta, quantity }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    return (await f.checkouts.start(f.a.shopId, added.token!))!;
  }

  const open = (view: CheckoutView) => {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  };

  /** A card worth `value` rupees: its ID and code. */
  async function card(value: string) {
    const issued = unwrap(await cards.create(f.a, { initialValue: value }));
    return { id: issued.giftCard.id, code: issued.code };
  }

  const balanceOf = async (id: string) => (await cards.get(f.a, id))!.balance;

  it('pays what it has of a cash-on-delivery order, the rest at the door, and gets it back if cancelled', async () => {
    const { id, code } = await card('1500');
    const secret = await checkout();
    // Typed as printed, in groups of four, in small letters.
    const grouped = code.toLowerCase().replace(/(.{4})(?=.)/g, '$1 ');
    const applied = open(await f.checkouts.applyGiftCard(secret, grouped));
    expect(applied.giftCard).toEqual({
      id,
      lastCharacters: code.slice(-4),
      balance: 150_000n,
      refusal: null,
    });
    const page = checkoutPage(applied);
    expect(page.html).toContain(
      `<span dir="ltr">•••• ${code.slice(-4)}</span> is applied: Rs 1,500 left.`,
    );
    expect(page.html).toContain(`Gift card (•••• ${code.slice(-4)})`);
    expect(page.html).toContain('Left to pay');
    expect(page.html).toContain('value="remove_gift_card"');

    const placed = await f.checkouts.place(secret, applied.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(placed.giftCards).toEqual([{ lastCharacters: code.slice(-4), amount: 150_000n }]);
    expect(placed.order).toMatchObject({
      total: 200_000n,
      amountPaid: 150_000n,
      codAmount: 50_000n,
      financialStatus: 'partially_paid',
    });
    expect(await balanceOf(id)).toBe(0n);
    expect(checkoutPage(placed).html).toContain(`Gift card (•••• ${code.slice(-4)})`);
    // The thank-you page, read again, says the same.
    const again = await f.checkouts.view(secret);
    expect(again.kind === 'placed' && again.giftCards).toEqual([
      { lastCharacters: code.slice(-4), amount: 150_000n },
    ]);
    const { rows } = await f.admin.query<{ message: string }>(
      `SELECT message FROM orders.order_events WHERE order_id = $1 AND kind = 'paid'`,
      [placed.order.id],
    );
    expect(rows.map((row) => row.message)).toEqual([
      `Paid Rs 1,500 with gift card •••• ${code.slice(-4)}: Rs 500 is left to collect at the door`,
    ]);

    // Cancelled: the card gets it back, and the order is no longer paid.
    const cancelled = unwrap(await f.orders.cancel(f.a, placed.order.id, { reason: 'customer' }));
    expect(cancelled).toMatchObject({ amountPaid: 0n, financialStatus: 'voided' });
    expect(await balanceOf(id)).toBe(150_000n);
    const ledger = await cards.transactions(f.a, id, { first: 10 });
    expect(ledger.items.map((item) => [item.kind, item.amount, item.orderId])).toEqual([
      ['debit_revert', 150_000n, placed.order.id],
      ['debit', -150_000n, placed.order.id],
      ['issue', 150_000n, null],
    ]);
  });

  it('pays a whole order it covers, keeping the rest for the next', async () => {
    const { id, code } = await card('5000');
    const secret = await checkout();
    const applied = open(await f.checkouts.applyGiftCard(secret, code));
    const placed = await f.checkouts.place(secret, applied.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(placed.order).toMatchObject({
      amountPaid: 200_000n,
      codAmount: 0n,
      financialStatus: 'paid',
    });
    expect(await balanceOf(id)).toBe(300_000n);
  });

  it('refuses a code no card has, one that cannot pay, and too many tries', async () => {
    const secret = await checkout();
    const unknown = open(await f.checkouts.applyGiftCard(secret, 'NOT A CARD 123'));
    expect(unknown.problem).toEqual({
      kind: 'gift_card',
      code: 'NOT A CARD 123',
      refusal: 'unknown',
    });
    expect(unknown.giftCard).toBeNull();
    const page = checkoutPage(unknown);
    expect(page.status).toBe(422);
    expect(page.html).toContain('no gift card with this code here.');
    expect(page.html).toContain('value="NOT A CARD 123"');

    const spent = await card('100');
    unwrap(await cards.debit(f.a, spent.id, { amount: '100' }));
    expect(open(await f.checkouts.applyGiftCard(secret, spent.code)).problem).toMatchObject({
      refusal: 'empty',
    });
    const off = await card('100');
    unwrap(await cards.deactivate(f.a, off.id));
    expect(open(await f.checkouts.applyGiftCard(secret, off.code)).problem).toMatchObject({
      refusal: 'deactivated',
    });

    // Codes no card has count; past the limit, not even a good one is taken.
    for (let i = 1; i < GIFT_CARD_ATTEMPTS; i += 1) {
      await f.checkouts.applyGiftCard(secret, `WRONGCODE${i}`);
    }
    const good = await card('100');
    const refused = open(await f.checkouts.applyGiftCard(secret, good.code));
    expect(refused.problem).toMatchObject({ kind: 'gift_card', refusal: 'attempts' });
    expect(refused.giftCard).toBeNull();
  });

  it('places nothing with a card that can no longer pay, until it is taken off', async () => {
    const { id, code } = await card('500');
    const secret = await checkout();
    const applied = open(await f.checkouts.applyGiftCard(secret, code));
    // Spent elsewhere meanwhile.
    unwrap(await cards.debit(f.a, id, { amount: '500' }));
    const refused = open(await f.checkouts.place(secret, applied.shown, FORM));
    expect(refused.problem).toEqual({ kind: 'gift_card', code: '', refusal: 'empty' });
    expect(checkoutPage(refused).html).toContain('This gift card has nothing left on it.');
    const { rows } = await f.admin.query('SELECT id FROM orders.orders');
    expect(rows).toEqual([]);

    const removed = open(await f.checkouts.removeGiftCard(secret));
    expect(removed.giftCard).toBeNull();
    const placed = await f.checkouts.place(secret, removed.shown, FORM);
    expect(placed.kind).toBe('placed');
  });
});
