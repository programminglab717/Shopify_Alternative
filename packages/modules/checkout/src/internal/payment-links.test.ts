import 'reflect-metadata';
import { StorefrontSite } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FORM, type CheckoutForm, type CheckoutView } from './checkout.service.js';
import { checkoutPage } from './checkout-pages.js';
import { PaymentLinkService } from './payment-link.service.js';
import { linkIsOpen } from './payment-links.js';
import { paymentLinks } from './schema.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

const FORM: CheckoutForm = {
  ...EMPTY_FORM,
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  city: 'khi',
  address1: 'House 12, Street 4, Block 5',
  address2: 'Gulshan-e-Iqbal',
};

const ACCOUNT = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
  instructions: '',
};

describe('linkIsOpen', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  const link = { active: true, expiresAt: null, usageLimit: null, ordersPlaced: 0 };

  it('is open while active, before its time, and short of its orders', () => {
    expect(linkIsOpen(link, now)).toBe(true);
    expect(linkIsOpen({ ...link, active: false }, now)).toBe(false);
    expect(linkIsOpen({ ...link, expiresAt: new Date('2026-10-07T11:00:00Z') }, now)).toBe(true);
    expect(linkIsOpen({ ...link, expiresAt: now }, now)).toBe(false);
    expect(linkIsOpen({ ...link, usageLimit: 3, ordersPlaced: 2 }, now)).toBe(true);
    expect(linkIsOpen({ ...link, usageLimit: 3, ordersPlaced: 3 }, now)).toBe(false);
  });
});

describe.skipIf(!server)('PaymentLinkService', () => {
  let f: CheckoutFixture;
  let links: PaymentLinkService;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
    links = new PaymentLinkService(
      f.db,
      f.variants,
      f.carts,
      f.checkouts,
      new StorefrontSite('https://hatti.test'),
    );
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM checkout.payment_links');
  });

  /** Two lawn suits in stock, by size. */
  async function lawn(owner = f.a) {
    const [small, medium] = await f.variantsOf(owner, 'Lawn 3-piece', {
      sizes: ['S', 'M'],
      price: '4,500',
    });
    await f.stock(owner, small!, 5);
    await f.stock(owner, medium!, 5);
    return { small: small!, medium: medium! };
  }

  /** The token in a link's address. */
  function tokenOf(url: string): string {
    return url.split('/pay/')[1]!;
  }

  async function opened(token: string, owner = f.a): Promise<string> {
    const result = await links.open(owner.shopId, token);
    if (result.kind !== 'checkout') throw new Error(`Expected a checkout, got ${result.kind}`);
    return result.secret;
  }

  function open(view: CheckoutView) {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  }

  function placedOrder(view: CheckoutView) {
    if (view.kind !== 'placed') {
      const problem = view.kind === 'open' ? JSON.stringify(view.problem) : '';
      throw new Error(`Expected a placed order, got ${view.kind} ${problem}`);
    }
    return view.order;
  }

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(paymentLinks).limit(1));
  });

  it("makes a link of the shop's items at an address of its own, recorded", async () => {
    const { small, medium } = await lawn();
    unwrap(await f.codes.create(f.a, { code: 'EID10', percentage: 10 }));
    const link = unwrap(
      await links.create(f.a, {
        title: ' Eid lawn on Instagram ',
        // A variant given twice is one item, its quantities added up.
        items: [
          { variantId: small, quantity: 1 },
          { variantId: medium },
          { variantId: small, quantity: 2 },
        ],
        discountCode: 'EID10',
        usageLimit: 50,
      }),
    );
    expect(link).toMatchObject({
      title: 'Eid lawn on Instagram',
      items: [
        { variantId: small, quantity: 3, title: 'Lawn 3-piece (S)' },
        { variantId: medium, quantity: 1, title: 'Lawn 3-piece (M)' },
      ],
      discountCode: 'EID10',
      prepaidOnly: false,
      usageLimit: 50,
      ordersPlaced: 0,
      lastOrderAt: null,
      expiresAt: null,
      active: true,
      open: true,
    });
    expect(link.url).toMatch(/^https:\/\/.+\/pay\/[\w-]{22}$/);
    expect(await links.get(f.a, link.id)).toEqual(link);
    expect(await links.get(f.b, link.id)).toBeNull();
    expect(
      (await f.outbox())
        .filter((row) => row.event_type.startsWith('payment_link.'))
        .map((row) => [row.event_type, row.aggregate_id, row.payload]),
    ).toEqual([['payment_link.created', link.id, { changed: [] }]]);
  });

  it("refuses a link without a title or items, or with what is not the shop's", async () => {
    const { small } = await lawn();
    const [theirs] = await f.variantsOf(f.b, 'Kurta');
    const errors = async (input: Parameters<PaymentLinkService['create']>[1]) => {
      const result = await links.create(f.a, input);
      return result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.code]);
    };
    expect(await errors({ title: ' ', items: [] })).toEqual([
      ['input.title', 'BLANK'],
      ['input.items', 'BLANK'],
    ]);
    expect(
      await errors({
        title: 'Too many',
        items: Array.from({ length: 21 }, () => ({ variantId: small })),
      }),
    ).toEqual([['input.items', 'TOO_MANY']]);
    expect(
      await errors({ title: 'Zero', items: [{ variantId: small, quantity: 0 }], usageLimit: 0 }),
    ).toEqual([
      ['input.items.0.quantity', 'INVALID'],
      ['input.usageLimit', 'INVALID'],
    ]);
    expect(
      await errors({ title: 'Theirs', items: [{ variantId: small }, { variantId: theirs! }] }),
    ).toEqual([['input.items.1.variantId', 'NOT_FOUND']]);
    expect(
      await errors({ title: 'Code', items: [{ variantId: small }], discountCode: 'NOPE' }),
    ).toEqual([['input.discountCode', 'NOT_FOUND']]);
    expect(await links.list(f.a)).toEqual([]);
  });

  it('changes what is given, records what changed, and lists the newest first', async () => {
    const { small, medium } = await lawn();
    const first = unwrap(
      await links.create(f.a, { title: 'First', items: [{ variantId: small }] }),
    );
    const second = unwrap(
      await links.create(f.a, { title: 'Second', items: [{ variantId: medium }] }),
    );
    expect((await links.list(f.a)).map((link) => link.title)).toEqual(['Second', 'First']);
    expect((await links.list(f.a, { first: 1 })).map((link) => link.title)).toEqual(['Second']);
    expect((await links.list(f.a, { after: second.id })).map((link) => link.title)).toEqual([
      'First',
    ]);
    expect(await links.list(f.b)).toEqual([]);

    const expiresAt = new Date(Date.now() + 86_400_000);
    const changed = unwrap(
      await links.update(f.a, first.id, {
        title: 'First',
        items: [{ variantId: medium, quantity: 2 }],
        prepaidOnly: true,
        expiresAt,
      }),
    );
    expect(changed).toMatchObject({
      url: first.url,
      items: [{ variantId: medium, quantity: 2 }],
      prepaidOnly: true,
      expiresAt,
    });
    // Nothing new: nothing recorded.
    unwrap(await links.update(f.a, first.id, { prepaidOnly: true }));
    const closed = unwrap(await links.update(f.a, first.id, { active: false }));
    expect([closed.active, closed.open]).toEqual([false, false]);
    expect(
      (await f.outbox())
        .filter((row) => row.event_type === 'payment_link.updated')
        .map((row) => row.payload),
    ).toEqual([{ changed: ['items', 'prepaidOnly', 'expiresAt'] }, { changed: ['active'] }]);
    const missing = await links.update(f.b, first.id, { active: true });
    expect(missing.ok ? null : missing.errors[0]!.code).toBe('NOT_FOUND');
  });

  it('opens a checkout of its own for each customer, its code applied, and counts their orders', async () => {
    const { small, medium } = await lawn();
    unwrap(await f.codes.create(f.a, { code: 'EID10', percentage: 10 }));
    const link = unwrap(
      await links.create(f.a, {
        title: 'Eid lawn',
        items: [
          { variantId: small, quantity: 2 },
          { variantId: medium, quantity: 1 },
        ],
        discountCode: 'EID10',
      }),
    );
    const token = tokenOf(link.url);
    const one = await opened(token);
    const two = await opened(token);
    expect(one).not.toBe(two);
    const view = open(await f.checkouts.view(one));
    expect(view.cart.items.map((item) => [item.variantId, item.quantity])).toEqual([
      [medium, 1],
      [small, 2],
    ]);
    expect(view.discount?.code).toBe('EID10');
    expect(view.paymentLink).toEqual({ id: link.id, title: 'Eid lawn' });
    // Cash on delivery, as any checkout of the shop's offers it.
    expect(view.payments.codRefusal).toBeNull();

    const order = placedOrder(await f.checkouts.place(one, view.shown, FORM));
    expect(order.discountCodes).toEqual(['EID10']);
    const { rows } = await f.admin.query<{ message: string }>(
      `SELECT message FROM orders.order_events WHERE order_id = $1 AND kind = 'created'`,
      [order.id],
    );
    expect(rows[0]!.message).toContain(
      'placed from the online store through the payment link "Eid lawn"',
    );
    const other = open(await f.checkouts.view(two));
    placedOrder(await f.checkouts.place(two, other.shown, { ...FORM, phone: '0321-7654321' }));
    const counted = (await links.get(f.a, link.id))!;
    expect(counted.ordersPlaced).toBe(2);
    expect(counted.lastOrderAt).toBeInstanceOf(Date);
  });

  it('opens nothing once closed, past its time or used up, nor for an address it lacks', async () => {
    const { small } = await lawn();
    const link = unwrap(
      await links.create(f.a, { title: 'Once', items: [{ variantId: small }], usageLimit: 1 }),
    );
    const token = tokenOf(link.url);
    expect(await links.open(f.b.shopId, token)).toEqual({ kind: 'not_found' });
    expect(await links.open(f.a.shopId, 'x'.repeat(22))).toEqual({ kind: 'not_found' });
    expect(await links.open(f.a.shopId, '../checkouts')).toEqual({ kind: 'not_found' });

    // Two customers open it; the first to order uses it up, and the second's page says so.
    const first = await opened(token);
    const second = await opened(token);
    const view = open(await f.checkouts.view(first));
    placedOrder(await f.checkouts.place(first, view.shown, FORM));
    expect(await links.open(f.a.shopId, token)).toEqual({ kind: 'closed' });
    const late = await f.checkouts.view(second);
    expect(late).toMatchObject({ kind: 'closed', reason: 'closed' });
    expect(
      (await f.checkouts.place(second, view.shown, { ...FORM, phone: '0321-7654321' })).kind,
    ).toBe('closed');
    // The order placed still shows on its own page.
    expect((await f.checkouts.view(first)).kind).toBe('placed');

    unwrap(await links.update(f.a, link.id, { usageLimit: null, expiresAt: new Date(1_000) }));
    expect(await links.open(f.a.shopId, token)).toEqual({ kind: 'closed' });
    unwrap(await links.update(f.a, link.id, { expiresAt: null, active: false }));
    expect(await links.open(f.a.shopId, token)).toEqual({ kind: 'closed' });
    unwrap(await links.update(f.a, link.id, { active: true }));
    expect((await links.open(f.a.shopId, token)).kind).toBe('checkout');
  });

  it('leaves out what is sold out, and opens nothing when all of it is', async () => {
    const { small, medium } = await lawn();
    const [kurta] = await f.variantsOf(f.a, 'Kurta');
    await f.stock(f.a, kurta!, 0);
    const link = unwrap(
      await links.create(f.a, {
        title: 'Mixed',
        items: [{ variantId: kurta! }, { variantId: small }],
      }),
    );
    const view = open(await f.checkouts.view(await opened(tokenOf(link.url))));
    expect(view.cart.items.map((item) => item.variantId)).toEqual([small]);

    const gone = unwrap(await links.create(f.a, { title: 'Gone', items: [{ variantId: kurta! }] }));
    expect(await links.open(f.a.shopId, tokenOf(gone.url))).toEqual({ kind: 'unavailable' });
    expect(medium).toBeTruthy();
  });

  it('takes a link the shop takes prepaid alone by transfer, never on delivery', async () => {
    const { small } = await lawn();
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: ACCOUNT }));
    const link = unwrap(
      await links.create(f.a, {
        title: 'Prepaid',
        items: [{ variantId: small }],
        prepaidOnly: true,
      }),
    );
    const secret = await opened(tokenOf(link.url));
    const view = open(await f.checkouts.view(secret));
    expect(view.payments.codRefusal).toEqual({ reason: 'link' });
    expect(view.problem).toBeNull();
    expect(checkoutPage(view).html).toContain(
      'This link is for paying in advance. Pay by bank transfer to place your order.',
    );
    // Cash on delivery, asked for anyway, is not taken.
    expect(
      open(await f.checkouts.place(secret, view.shown, { ...FORM, payment: 'cash_on_delivery' }))
        .problem,
    ).toEqual({ kind: 'changed' });
    const order = placedOrder(
      await f.checkouts.place(secret, view.shown, { ...FORM, payment: 'bank_transfer' }),
    );
    expect([order.paymentMethod, order.stage]).toEqual(['bank_transfer', 'awaiting_payment']);

    // Without a way to pay before, the page says to ask the shop.
    unwrap(await f.bankTransfer.update(f.a, { enabled: false, account: ACCOUNT }));
    const stuck = open(await f.checkouts.view(await opened(tokenOf(link.url))));
    expect(stuck.problem).toEqual({ kind: 'cod_unavailable', refusal: { reason: 'link' } });
  });

  it("says why a link opens no checkout, in the shop's colours", async () => {
    const pages = await Promise.all(
      (['not_found', 'closed', 'sold_out'] as const).map(async (reason) =>
        checkoutPage(await f.checkouts.linkPageView(f.a.shopId, reason)),
      ),
    );
    expect(pages.map((page) => page.status)).toEqual([404, 410, 200]);
    expect(pages[0]!.html).toContain('This link doesn&#39;t exist');
    expect(pages[1]!.html).toContain('This link no longer takes orders');
    expect(pages[1]!.html).toContain('یہ لنک اب آرڈر نہیں لیتا');
    expect(pages[2]!.html).toContain('This is sold out for now');
  });
});
