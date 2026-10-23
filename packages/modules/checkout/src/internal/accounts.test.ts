import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { BundleService } from '@hatti/catalog/public';
import { sha256 } from '@hatti/crypto';
import {
  CustomerDataRegistry,
  CustomerDataService,
  CustomerService,
  StoreCreditService,
} from '@hatti/customers/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { MESSAGING_CUSTOMER_DATA } from '@hatti/messaging/public';
import { ORDER_CUSTOMER_DATA } from '@hatti/orders/public';
import { ACCOUNT_ADDRESSES_MAX, type AccountAddressRequest } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_DATA } from './account-data.js';
import { ACCOUNT_SESSION, type SignInVerify } from './account.service.js';
import { parseAction } from './cart-lines.js';
import type { CheckoutForm } from './checkout.service.js';
import { checkoutPage } from './checkout-pages.js';
import { CHECKOUT_CUSTOMER_DATA } from './customer-data.js';
import { NUMBER_CODE } from './number-codes.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

const JAZZ = '+923001234567';
const ZONG = '+923111234567';
const DAY_MS = 86_400_000;

describe.skipIf(!server)("Shoppers' accounts, signed in to by a code (CUS-02, ADR-570)", () => {
  let f: CheckoutFixture;
  let kurta: string;
  let customers: CustomerService;
  let credit: StoreCreditService;
  let data: CustomerDataService;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
    customers = new CustomerService(f.db);
    credit = new StoreCreditService(f.db);
    const registry = new CustomerDataRegistry();
    registry.register(ORDER_CUSTOMER_DATA);
    registry.register(CHECKOUT_CUSTOMER_DATA);
    registry.register(MESSAGING_CUSTOMER_DATA);
    data = new CustomerDataService(f.db, registry);
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

  /** A checkout of a kurta in `tenant`'s shop: its secret and what its page showed. */
  async function checkout(tenant: TenantContext = f.a, variantId = kurta) {
    const action = parseAction('add', { items: [{ variantId, quantity: 2 }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(tenant.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await f.checkouts.start(tenant.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return { secret, shown: view.shown };
  }

  /** An order placed through checkout by the shopper with `phone`; its ID. */
  async function order(phone: string, tenant: TenantContext = f.a, variantId = kurta) {
    const { secret, shown } = await checkout(tenant, variantId);
    const placed = await f.checkouts.place(secret, shown, { ...FORM, phone });
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    return placed.order;
  }

  /** The codes sent of `kind`, the newest last. */
  const sent = async (kind = 'account_code') =>
    (
      await f.admin.query<{
        channel: string;
        recipient: string;
        language: string;
        code: string;
        shop: string;
      }>(
        `SELECT channel, recipient, language, variables ->> 'code' AS code,
                variables ->> 'shop' AS shop
           FROM messaging.messages WHERE kind = $1 ORDER BY created_at, id`,
        [kind],
      )
    ).rows;

  /** Signs `phone` in to `tenant`'s shop with the code sent to it: the session's token. */
  async function signIn(phone: string, tenant: TenantContext = f.a): Promise<string> {
    expect(await f.accounts.startSignIn(tenant.shopId, { phone })).toMatchObject({ kind: 'sent' });
    const code = (await sent()).at(-1)!.code;
    const verified = await f.accounts.verifySignIn(tenant.shopId, { phone, code });
    if (verified.kind !== 'signed_in') throw new Error(`Expected signed in, got ${verified.kind}`);
    return verified.token;
  }

  const wrongOf = (code: string) => String((Number(code) + 1) % 10 ** 6).padStart(6, '0');

  it('sends a code in words of its own, the same for any number, and signs in with it once', async () => {
    unwrap(await customers.create(f.a, { phone: '0300 1234567', name: 'Ayesha Khan' }));
    // A customer's number, and a number the shop has never seen: the same answer.
    const known = await f.accounts.startSignIn(f.a.shopId, {
      phone: '0300-1234567',
      locale: 'ur-PK',
    });
    const unknown = await f.accounts.startSignIn(
      f.a.shopId,
      { phone: '0311 1234567', channel: 'sms' },
      { ip: '203.0.113.9' },
    );
    expect(known).toEqual({ kind: 'sent', phone: '0300 ••••567', channel: 'whatsapp' });
    expect(unknown).toEqual({ kind: 'sent', phone: '0311 ••••567', channel: 'sms' });
    const [toAyesha, toZong] = await sent();
    expect(toAyesha).toMatchObject({ channel: 'whatsapp', recipient: JAZZ, language: 'ur' });
    expect(toZong).toMatchObject({ channel: 'sms', recipient: ZONG, language: 'en', shop: 'A' });
    expect(toAyesha!.code).toMatch(/^\d{6}$/);
    // None as checkout's: those say they place an order.
    expect(await sent('one_time_code')).toEqual([]);
    // A code kept as a digest, for signing in, with no checkout, and the address it was asked from.
    const { rows: codes } = await f.admin.query<Record<string, unknown>>(
      `SELECT purpose, checkout_id, host(ip) AS ip FROM checkout.number_codes
        ORDER BY created_at, id`,
    );
    expect(codes).toEqual([
      { purpose: 'sign_in', checkout_id: null, ip: null },
      { purpose: 'sign_in', checkout_id: null, ip: '203.0.113.9' },
    ]);
    expect(await f.accounts.startSignIn(f.a.shopId, { phone: '042 1234567' })).toMatchObject({
      kind: 'invalid',
      errors: [{ field: ['phone'] }],
    });

    const signedIn = await f.accounts.verifySignIn(f.a.shopId, {
      phone: '0300 1234567',
      code: ` ${toAyesha!.code} `,
    });
    if (signedIn.kind !== 'signed_in') throw new Error(`Expected signed in, got ${signedIn.kind}`);
    expect(signedIn.token).toMatch(/^[\w-]{43}$/);
    expect(signedIn.session).toMatchObject({ phone: JAZZ, name: 'Ayesha Khan' });
    const lasts = signedIn.session.expiresAt.getTime() - signedIn.session.signedInAt.getTime();
    expect(lasts).toBe(ACCOUNT_SESSION.idleDays * DAY_MS);
    // Only the token's digest is kept.
    const { rows: kept } = await f.admin.query<{ token_hash: Buffer; phone: string }>(
      'SELECT token_hash, phone FROM checkout.account_sessions',
    );
    expect(kept).toEqual([{ token_hash: sha256(signedIn.token), phone: JAZZ }]);
    // A code signs in once.
    expect(
      await f.accounts.verifySignIn(f.a.shopId, { phone: JAZZ, code: toAyesha!.code }),
    ).toEqual({ kind: 'expired' });
    // A number with no customer signs in all the same, to an account with nothing in it.
    const nobody = await f.accounts.verifySignIn(f.a.shopId, {
      phone: '0311-1234567',
      code: toZong!.code,
    });
    expect(nobody).toMatchObject({ kind: 'signed_in', session: { phone: ZONG, name: null } });
    expect(await f.accounts.account(f.a.shopId, (nobody as { token: string }).token)).toEqual({
      phone: ZONG,
      name: null,
      orders: [],
      storeCredit: { balance: 0, currency: 'PKR', expiring: null, history: [] },
      dataRequests: { available: false, erasureWaitDays: 10, export: null, erasure: null },
    });
    // Not in another shop.
    expect(await f.accounts.session(f.b.shopId, signedIn.token)).toBeNull();
    expect(await f.accounts.verifySignIn(f.a.shopId, { phone: 'no', code: '1' })).toEqual({
      kind: 'invalid',
    });
  });

  it("keeps sign-in codes and checkout's apart, counting them together against the number", async () => {
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    const { secret, shown } = await checkout();
    // Checkout's code signs no one in.
    await f.checkouts.place(secret, shown, FORM);
    const [atCheckout] = await sent('one_time_code');
    expect(
      await f.accounts.verifySignIn(f.a.shopId, { phone: JAZZ, code: atCheckout!.code }),
    ).toEqual({ kind: 'expired' });
    // And a code to sign in places no order: checkout's own is still the one it asks for.
    await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ });
    const [toSignIn] = await sent();
    if (toSignIn!.code !== atCheckout!.code) {
      const refused = await f.checkouts.place(secret, shown, { ...FORM, code: toSignIn!.code });
      expect(refused.kind === 'open' && refused.problem).toMatchObject({
        kind: 'code',
        state: 'wrong',
      });
      expect((await f.admin.query('SELECT 1 FROM orders.orders')).rows).toEqual([]);
    }
    // Signing in still works with its own, the checkout's tries not counted against it.
    const signedIn = await f.accounts.verifySignIn(f.a.shopId, {
      phone: JAZZ,
      code: toSignIn!.code,
    });
    expect(signedIn.kind).toBe('signed_in');

    // The number's codes in a day are counted across both: 2 sent so far.
    for (let n = 2; n < NUMBER_CODE.perNumberDaily; n++) {
      expect(await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ })).toMatchObject({
        kind: 'sent',
      });
    }
    expect(await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ })).toEqual({
      kind: 'too_many',
      phone: '0300 ••••567',
      channel: 'whatsapp',
    });
    // And an address's in an hour, whatever the numbers.
    const ip = { ip: '198.51.100.7' };
    for (let n = 0; n < NUMBER_CODE.perAddressHourly; n++) {
      const phone = `0333 ${String(1_000_000 + n)}`;
      expect(await f.accounts.startSignIn(f.a.shopId, { phone }, ip)).toMatchObject({
        kind: 'sent',
      });
    }
    expect(await f.accounts.startSignIn(f.a.shopId, { phone: '0345 1234567' }, ip)).toMatchObject({
      kind: 'too_many',
    });
    expect(await f.accounts.startSignIn(f.b.shopId, { phone: '0345 1234567' }, ip)).toMatchObject({
      kind: 'sent',
    });
  });

  it('takes five tries at a code, for ten minutes, the last sent alone working', async () => {
    await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ });
    await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ, channel: 'sms' });
    const [first, second] = await sent();
    // The first no longer works: typed, it is a try at the second.
    const tries: SignInVerify['kind'][] = [];
    if (first!.code !== second!.code) {
      tries.push(
        (await f.accounts.verifySignIn(f.a.shopId, { phone: JAZZ, code: first!.code })).kind,
      );
    }
    const wrong = wrongOf(second!.code);
    while (tries.length < NUMBER_CODE.attempts) {
      tries.push((await f.accounts.verifySignIn(f.a.shopId, { phone: JAZZ, code: wrong })).kind);
    }
    expect(tries.at(-1)).toBe('too_many');
    expect(tries.slice(0, -1).every((kind) => kind === 'wrong')).toBe(true);
    // Its tries used up, the right code no longer signs in.
    expect(await f.accounts.verifySignIn(f.a.shopId, { phone: JAZZ, code: second!.code })).toEqual({
      kind: 'too_many',
    });
    // A new one does, while its ten minutes last.
    await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ });
    const third = (await sent()).at(-1)!;
    await f.admin.query(
      `UPDATE checkout.number_codes SET expires_at = now() - interval '1 second'
        WHERE id = (SELECT id FROM checkout.number_codes ORDER BY created_at DESC LIMIT 1)`,
    );
    expect(await f.accounts.verifySignIn(f.a.shopId, { phone: JAZZ, code: third.code })).toEqual({
      kind: 'expired',
    });
    // None sent to another number.
    expect(await f.accounts.verifySignIn(f.a.shopId, { phone: ZONG, code: third.code })).toEqual({
      kind: 'expired',
    });
    expect((await f.admin.query('SELECT 1 FROM checkout.account_sessions')).rows).toEqual([]);
  });

  it('keeps a session going while it is used, for 90 days at most, until it signs out', async () => {
    const token = await signIn(JAZZ);
    const session = (await f.accounts.session(f.a.shopId, token))!;
    expect(session.phone).toBe(JAZZ);
    const row = async () =>
      (
        await f.admin.query<{ last_seen_at: Date; expires_at: Date; created_at: Date }>(
          'SELECT last_seen_at, expires_at, created_at FROM checkout.account_sessions',
        )
      ).rows[0]!;
    // Used within the hour, nothing is written.
    const before = await row();
    await f.accounts.session(f.a.shopId, token);
    expect(await row()).toEqual(before);
    // Used again later, it ends 30 days from now.
    await f.admin.query(
      `UPDATE checkout.account_sessions
          SET created_at = created_at - interval '20 days',
              last_seen_at = last_seen_at - interval '20 days',
              expires_at = expires_at - interval '20 days'`,
    );
    const slid = (await f.accounts.session(f.a.shopId, token))!;
    expect(slid.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    expect((await row()).last_seen_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // But never past 90 days from signing in.
    await f.admin.query(
      `UPDATE checkout.account_sessions
          SET created_at = now() - interval '80 days', last_seen_at = now() - interval '2 hours',
              expires_at = now() + interval '5 days'`,
    );
    const capped = (await f.accounts.session(f.a.shopId, token))!;
    expect(Math.abs(capped.expiresAt.getTime() - (Date.now() + 10 * DAY_MS))).toBeLessThan(60_000);
    // Lapsed, it reads nothing, and the sweep deletes it.
    await f.admin.query(
      `UPDATE checkout.account_sessions SET expires_at = now() - interval '1 second'`,
    );
    expect(await f.accounts.session(f.a.shopId, token)).toBeNull();
    expect(await f.accounts.account(f.a.shopId, token)).toBeNull();
    expect((await f.expiry.deleteExpired()).sessions).toBe(1);

    // Signed out, likewise.
    const again = await signIn(JAZZ);
    expect(await f.accounts.signOut(f.a.shopId, again)).toBe(true);
    expect(await f.accounts.signOut(f.a.shopId, again)).toBe(false);
    expect(await f.accounts.session(f.a.shopId, again)).toBeNull();
    expect((await f.expiry.deleteExpired()).sessions).toBe(1);
    // A token that is none names nothing, unlooked for.
    expect(await f.accounts.session(f.a.shopId, 'x')).toBeNull();
    expect(await f.accounts.session(f.a.shopId, 'x'.repeat(43))).toBeNull();
    expect(await f.accounts.signOut(f.a.shopId, 'x')).toBe(false);
  });

  it("reads the customer's orders and store credit, merged numbers too, and no other shop's", async () => {
    const [shawl] = (await f.variantsOf(f.b, 'Shawl', { price: '1,500' })) as [string];
    await f.stock(f.b, shawl, 10);
    const first = await order('0300 1234567');
    const second = await order('0300 1234567');
    // Another of theirs, on a number the shop merges into them later.
    const other = await order('0311 1234567');
    // Another shop's, on the same number.
    await order('0300 1234567', f.b, shawl);
    const ayesha = first.customerId;
    unwrap(
      await credit.credit(
        f.a,
        { customerId: ayesha },
        { amount: '500', currencyCode: 'PKR', expiresAt: new Date(Date.now() + 10 * DAY_MS) },
      ),
    );
    unwrap(
      await credit.credit(f.a, { customerId: ayesha }, { amount: '250', currencyCode: 'PKR' }),
    );

    const token = await signIn(JAZZ);
    const account = (await f.accounts.account(f.a.shopId, token))!;
    expect(account).toMatchObject({ phone: JAZZ, name: 'Ayesha Khan' });
    expect(account.orders.map((placed) => placed.id)).toEqual([
      toPublicId('order', second.id),
      toPublicId('order', first.id),
    ]);
    expect(account.orders[0]).toEqual({
      id: toPublicId('order', second.id),
      name: `#${second.number}`,
      placedAt: second.createdAt.toISOString(),
      status: 'open',
      financialStatus: 'pending',
      fulfillmentStatus: 'unfulfilled',
      total: Number(second.total),
      currency: 'PKR',
      itemCount: 2,
      hasPage: true,
      lines: [
        {
          variantId: kurta,
          productTitle: 'Kurta',
          variantTitle: null,
          quantity: 2,
          available: true,
        },
      ],
    });
    expect(account.storeCredit).toMatchObject({
      balance: 750_00,
      currency: 'PKR',
      expiring: { amount: 500_00, expiresAt: expect.any(String) as unknown },
    });
    // What happened to it, the newest first, the shop's notes its own (ADR-668).
    expect(account.storeCredit.history).toEqual([
      {
        kind: 'credit',
        event: 'adjustment',
        amount: 250_00,
        balanceAfter: 750_00,
        at: expect.any(String) as unknown,
        expiresAt: null,
        orderId: null,
      },
      {
        kind: 'credit',
        event: 'adjustment',
        amount: 500_00,
        balanceAfter: 500_00,
        at: expect.any(String) as unknown,
        expiresAt: expect.any(String) as unknown,
        orderId: null,
      },
    ]);

    // Merged, the other number's orders are theirs, and its sessions read their account.
    const otherToken = await signIn(ZONG);
    expect((await f.accounts.account(f.a.shopId, otherToken))!.orders).toHaveLength(1);
    unwrap(await data.merge(f.a, ayesha, other.customerId));
    for (const signedIn of [token, otherToken]) {
      const merged = (await f.accounts.account(f.a.shopId, signedIn))!;
      expect(merged.orders.map((placed) => placed.id)).toEqual([
        toPublicId('order', other.id),
        toPublicId('order', second.id),
        toPublicId('order', first.id),
      ]);
      expect(merged.name).toBe('Ayesha Khan');
    }
    const { rows } = await f.admin.query<{ customer_id: string }>(
      'SELECT DISTINCT customer_id FROM checkout.account_sessions',
    );
    expect(rows).toEqual([{ customer_id: ayesha }]);

    // A cancelled order has no page.
    unwrap(await f.orders.cancel(f.a, first.id, { reason: 'customer' }));
    const after = (await f.accounts.account(f.a.shopId, token))!;
    expect(after.orders.find((placed) => placed.name === `#${first.number}`)).toMatchObject({
      status: 'cancelled',
      hasPage: false,
    });
  });

  it('offers what each order sold again, saying what the cart would take now (ADR-574)', async () => {
    const [small, medium] = (await f.variantsOf(f.a, 'Lawn 3-piece', {
      sizes: ['S', 'M'],
      price: '3,000',
    })) as [string, string];
    const [dupatta] = (await f.variantsOf(f.a, 'Chiffon dupatta')) as [string];
    const [cap] = (await f.variantsOf(f.a, 'Prayer cap')) as [string];
    const [suit] = (await f.variantsOf(f.a, 'Eid 3-piece suit', { price: '6,000' })) as [string];
    const [shirt] = (await f.variantsOf(f.a, 'Lawn shirt', { price: '4,000' })) as [string];
    const [trouser] = (await f.variantsOf(f.a, 'Cotton trouser')) as [string];
    for (const variant of [small, medium, dupatta, shirt, trouser]) await f.stock(f.a, variant, 10);
    // The last one there is.
    await f.stock(f.a, cap, 1);
    const productOf = async (variantId: string) =>
      (
        await f.db.tenant(f.a.shopId, (tx) => f.variants.snapshotsOf(tx, f.a.shopId, [variantId]))
      ).get(variantId)!.productId;
    const bundles = new BundleService(f.db);
    unwrap(
      await bundles.set(f.a, await productOf(suit), [
        { variantId: shirt, quantity: 1 },
        { variantId: trouser, quantity: 2 },
      ]),
    );
    const card = unwrap(
      await f.products.create(f.a, {
        title: 'Gift card',
        status: 'active',
        giftCard: true,
        variants: [{ price: '5,000' }],
      }),
    ).variants[0]!.id;

    const items = [
      { variantId: small, quantity: 1 },
      { variantId: medium, quantity: 2 },
      { variantId: kurta, quantity: 1 },
      { variantId: dupatta, quantity: 1 },
      { variantId: cap, quantity: 1 },
      { variantId: suit, quantity: 2 },
      { variantId: card, quantity: 1 },
    ];
    const action = parseAction('add', { items });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    const placed = await f.checkouts.place(secret, view.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);

    const token = await signIn(JAZZ);
    const linesOf = async () => (await f.accounts.account(f.a.shopId, token))!.orders[0]!.lines;
    const line = (variantId: string | null, productTitle: string, quantity: number) => ({
      variantId,
      productTitle,
      variantTitle: null,
      quantity,
      available: true,
    });
    // As sold: a bundle once, as itself; the gift card left out; the cap sold out by the order.
    const sold = [
      { ...line(small, 'Lawn 3-piece', 1), variantTitle: 'S' },
      { ...line(medium, 'Lawn 3-piece', 2), variantTitle: 'M' },
      line(kurta, 'Kurta', 1),
      line(dupatta, 'Chiffon dupatta', 1),
      { ...line(cap, 'Prayer cap', 1), available: false },
      line(suit, 'Eid 3-piece suit', 2),
    ];
    expect(await linesOf()).toEqual(sold);

    // A variant deleted, a product archived, and a bundle no longer as it was sold: none can be
    // had, as the cart would say; the titles are as they were sold.
    unwrap(await f.variants.bulkDelete(f.a, await productOf(small), [small]));
    unwrap(await f.products.update(f.a, { id: await productOf(dupatta), status: 'archived' }));
    unwrap(
      await bundles.set(f.a, await productOf(suit), [
        { variantId: shirt, quantity: 1 },
        { variantId: trouser, quantity: 1 },
      ]),
    );
    expect(await linesOf()).toEqual([
      { ...sold[0]!, available: false },
      sold[1],
      sold[2],
      { ...sold[3]!, available: false },
      sold[4],
      { ...sold[5]!, variantId: null, available: false },
    ]);
    // Its parts again: the bundle can be had, until a part's stock runs out.
    unwrap(
      await bundles.set(f.a, await productOf(suit), [
        { variantId: shirt, quantity: 1 },
        { variantId: trouser, quantity: 2 },
      ]),
    );
    expect((await linesOf())[5]).toEqual(sold[5]);
    await f.stock(f.a, trouser, 1);
    expect((await linesOf())[5]).toEqual({ ...sold[5]!, available: false });
  });

  it("opens an order's page through its link, keeping it while it is the order's", async () => {
    const placed = await order(JAZZ);
    const [shawl] = (await f.variantsOf(f.b, 'Shawl')) as [string];
    await f.stock(f.b, shawl, 10);
    const elsewhere = await order(JAZZ, f.b, shawl);
    const someoneElse = await order(ZONG);
    const token = await signIn(JAZZ);
    const id = toPublicId('order', placed.id);

    const link = (await f.accounts.orderLink(f.a.shopId, token, id))!;
    expect(link.path).toMatch(/^\/o\/[\w-]{22}$/);
    expect(link.url).toBe(`https://hatti.test${link.path}`);
    // Its page opens at that link.
    const { rows } = await f.admin.query<{ link_token_hash: Buffer }>(
      'SELECT link_token_hash FROM orders.orders WHERE id = $1',
      [placed.id],
    );
    expect(rows[0]!.link_token_hash).toEqual(sha256(link.path.slice('/o/'.length)));
    // Opened again, the same link, and the timeline says it went once.
    expect(await f.accounts.orderLink(f.a.shopId, token, id)).toEqual(link);
    const { rows: said } = await f.admin.query<{ message: string }>(
      `SELECT message FROM orders.order_events WHERE order_id = $1 AND kind = 'link'`,
      [placed.id],
    );
    expect(said.map((event) => event.message)).toEqual([
      'Sent the customer a link to open from their account on the storefront',
    ]);

    // Not another customer's order, nor another shop's, nor one that is none.
    expect(
      await f.accounts.orderLink(f.a.shopId, token, toPublicId('order', someoneElse.id)),
    ).toBeNull();
    expect(
      await f.accounts.orderLink(f.a.shopId, token, toPublicId('order', elsewhere.id)),
    ).toBeNull();
    expect(await f.accounts.orderLink(f.a.shopId, token, placed.id)).toBeNull();
    expect(await f.accounts.orderLink(f.a.shopId, 'x'.repeat(43), id)).toBeNull();
    // Cancelled, none.
    unwrap(await f.orders.cancel(f.a, placed.id, { reason: 'customer' }));
    expect(await f.accounts.orderLink(f.a.shopId, token, id)).toBeNull();
  });

  it("follows the number: a first order makes it someone's, and taken off them it ends", async () => {
    // Signed in before the number ordered: an empty account, then the customer it becomes.
    const token = await signIn(JAZZ);
    expect((await f.accounts.account(f.a.shopId, token))!.orders).toEqual([]);
    const placed = await order(JAZZ);
    expect((await f.accounts.account(f.a.shopId, token))!.orders).toHaveLength(1);
    const { rows } = await f.admin.query<{ customer_id: string }>(
      'SELECT customer_id FROM checkout.account_sessions',
    );
    expect(rows).toEqual([{ customer_id: placed.customerId }]);

    // Taken off the customer, it reads their account no more.
    unwrap(
      await customers.update(f.a, placed.customerId, {
        phone: '0333 1234567',
        otherPhones: [ZONG],
      }),
    );
    expect(await f.accounts.account(f.a.shopId, token)).toBeNull();
    expect(await f.accounts.session(f.a.shopId, token)).toBeNull();
    // Nor when the number is given to another: the session that proved it ends.
    const zong = await signIn(ZONG);
    unwrap(await customers.update(f.a, placed.customerId, { otherPhones: null }));
    unwrap(await customers.create(f.a, { phone: '0311 1234567', name: 'Bilal' }));
    expect(await f.accounts.session(f.a.shopId, zong)).toBeNull();
  });

  it("ends the sessions of an erased customer's numbers, and gives them in their own file", async () => {
    const placed = await order(JAZZ);
    const token = await signIn(JAZZ);
    await f.accounts.session(f.a.shopId, token);
    // Elsewhere, the same number's session stays.
    const [shawl] = (await f.variantsOf(f.b, 'Shawl')) as [string];
    await f.stock(f.b, shawl, 10);
    await order(JAZZ, f.b, shawl);
    const inB = await signIn(JAZZ, f.b);

    const filed = await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.export(tx, f.a.shopId, {
        id: placed.customerId,
        phones: [JAZZ],
        email: null,
      }),
    );
    expect(filed.accountSessions).toEqual([
      {
        number: JAZZ,
        signedInAt: expect.any(Date) as unknown,
        lastUsedAt: expect.any(Date) as unknown,
        endsAt: expect.any(Date) as unknown,
      },
    ]);

    unwrap(await f.orders.cancel(f.a, placed.id, { reason: 'customer' }));
    unwrap(await data.erase(f.a, placed.customerId));
    expect(await f.accounts.session(f.a.shopId, token)).toBeNull();
    const { rows } = await f.admin.query<{ shop_id: string }>(
      'SELECT shop_id FROM checkout.account_sessions',
    );
    expect(rows).toEqual([{ shop_id: f.b.shopId }]);
    // Their codes to sign in with go too; the other shop's stay.
    const { rows: codes } = await f.admin.query<{ shop_id: string }>(
      `SELECT shop_id FROM checkout.number_codes WHERE purpose = 'sign_in'`,
    );
    expect(codes).toEqual([{ shop_id: f.b.shopId }]);
    expect(await f.accounts.session(f.b.shopId, inB)).not.toBeNull();
    // Signed in again, the number reads an account with nothing in it: the erased orders name
    // a customer the shop no longer has.
    const fresh = await signIn(JAZZ);
    expect((await f.accounts.account(f.a.shopId, fresh))!.orders).toEqual([]);
  });

  /** What the shop's audit log says of the customer `id`, the newest first. */
  const auditOf = async (id: string) =>
    (
      await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 20, subjectId: id }))
    ).items.map((entry) => [entry.action, entry.actorKind, entry.actorId]);

  /** Files of shoppers' own data the shop keeps, the oldest first. */
  const files = async () =>
    (
      await f.admin.query<{ customer_id: string; key: string }>(
        'SELECT customer_id, key FROM checkout.account_data_exports ORDER BY created_at',
      )
    ).rows;

  it('gives a shopper the file of their own data, made once a day and kept for it (ADR-572)', async () => {
    // A number no customer has: nothing to give, and nothing made.
    const nobody = await signIn(ZONG);
    expect(await f.accounts.dataExport(f.a.shopId, nobody)).toEqual({ state: 'none' });
    expect((await f.accounts.account(f.a.shopId, nobody))!.dataRequests).toEqual({
      available: false,
      erasureWaitDays: 10,
      export: null,
      erasure: null,
    });
    // Without a session, nothing.
    expect(await f.accounts.dataExport(f.a.shopId, 'x'.repeat(43))).toBeNull();
    expect(await f.accounts.dataExport(f.a.shopId, 'not a token')).toBeNull();
    expect(await f.accounts.dataExportLink(f.a.shopId, 'x'.repeat(43))).toBeNull();

    const placed = await order(JAZZ);
    const ayesha = placed.customerId;
    const token = await signIn(JAZZ);
    expect(await f.accounts.dataExportLink(f.a.shopId, token)).toBeNull();
    const made = (await f.accounts.dataExport(f.a.shopId, token))!;
    if (made.state !== 'ready') throw new Error(`Expected a file, got ${made.state}`);
    expect(made).toMatchObject({ state: 'ready', made: true });
    expect(new Date(made.expiresAt).getTime() - new Date(made.readyAt).getTime()).toBe(
      ACCOUNT_DATA.keepHours * 3_600_000,
    );
    // Kept by storage under the shop's own prefix, behind a signed link that names the file.
    const [kept] = await files();
    expect(kept).toEqual({
      customer_id: ayesha,
      key: expect.stringMatching(
        new RegExp(`^shops/${f.a.shopId}/customer-data/[0-9a-f-]{36}\\.json$`),
      ) as unknown,
    });
    const url = new URL(made.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://hatti.test/storage/${kept!.key}`);
    expect(f.storage.verify('GET', kept!.key, Object.fromEntries(url.searchParams))).toEqual({
      method: 'GET',
      filename: `customer-${toPublicId('customer', ayesha)}.json`,
    });
    // The file staff would give them: their orders, and their account's sessions among the rest.
    const stored = (await f.storage.read(kept!.key))!;
    expect(stored.contentType).toBe('application/json');
    const file = JSON.parse(stored.body.toString('utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({
      format: 'hatti.customer-data/1',
      customer: { id: toPublicId('customer', ayesha), name: 'Ayesha Khan', phone: JAZZ },
      orders: [expect.objectContaining({ name: `#${placed.number}` })],
      accountSessions: [expect.objectContaining({ number: JAZZ })],
    });

    // Asked again the same day, the same file, with a new link: none is made.
    const again = (await f.accounts.dataExport(f.a.shopId, token))!;
    expect(again).toEqual({ ...made, made: false, url: expect.any(String) as unknown });
    expect(await f.accounts.dataExportLink(f.a.shopId, token)).toEqual({
      ...made,
      made: false,
      url: expect.any(String) as unknown,
    });
    expect(await files()).toHaveLength(1);
    expect((await f.accounts.account(f.a.shopId, token))!.dataRequests).toEqual({
      available: true,
      erasureWaitDays: 10,
      export: { state: 'ready', readyAt: made.readyAt, expiresAt: made.expiresAt },
      erasure: null,
    });
    // Made once, by the customer themselves, as the audit log says.
    expect(await auditOf(ayesha)).toEqual([['customer.data_exported', 'customer', ayesha]]);
    // Not another shop's.
    expect(await f.accounts.dataExport(f.b.shopId, token)).toBeNull();

    // A day on, storage lets it go, and another is made when asked.
    await f.admin.query(
      `UPDATE checkout.account_data_exports
          SET created_at = created_at - interval '25 hours',
              expires_at = expires_at - interval '25 hours'`,
    );
    expect((await f.accounts.account(f.a.shopId, token))!.dataRequests.export).toBeNull();
    expect(await f.accounts.dataExportLink(f.a.shopId, token)).toBeNull();
    expect(await f.accountData.deleteExpired()).toBe(1);
    expect(await f.storage.head(kept!.key)).toBeNull();
    expect(await files()).toEqual([]);
    expect(await f.accounts.dataExport(f.a.shopId, token)).toMatchObject({ made: true });
    expect(await auditOf(ayesha)).toEqual([
      ['customer.data_exported', 'customer', ayesha],
      ['customer.data_exported', 'customer', ayesha],
    ]);

    // Merged into another, their file is let go, and the customer kept may ask for one of all
    // that is now theirs.
    const [newer] = await files();
    const bilal = unwrap(await customers.create(f.a, { phone: '0333 1234567', name: 'Bilal' }));
    unwrap(await data.merge(f.a, bilal.id, ayesha));
    expect((await f.accounts.account(f.a.shopId, token))!.dataRequests.export).toBeNull();
    expect(await f.accountData.deleteExpired()).toBe(1);
    expect(await f.storage.head(newer!.key)).toBeNull();
    expect(await f.accounts.dataExport(f.a.shopId, token)).toMatchObject({ made: true });
    expect(await files()).toEqual([{ customer_id: bilal.id, key: expect.any(String) as unknown }]);
  });

  it("files a shopper's erasure as staff would, once, saying how it waits (ADR-572)", async () => {
    // A number no customer has: nothing to erase.
    const nobody = await signIn('+923331234567');
    expect(await f.accounts.dataErase(f.a.shopId, nobody)).toEqual({ state: 'none' });
    expect(await f.accounts.dataErase(f.a.shopId, 'x'.repeat(43))).toBeNull();

    // A customer with an order still open: held until it closes.
    const placed = await order(JAZZ);
    const ayesha = placed.customerId;
    const token = await signIn(JAZZ);
    const held = (await f.accounts.dataErase(f.a.shopId, token))!;
    if (held.state === 'none') throw new Error('Expected an erasure');
    expect(held.state).toBe('held');
    expect(new Date(held.eraseAfter).getTime() - new Date(held.requestedAt).getTime()).toBe(
      10 * DAY_MS,
    );
    // Asked again, the same request; so too when staff ask, and the customer is named as who
    // asked, in the staff's list of erasures waiting.
    expect(await f.accounts.dataErase(f.a.shopId, token)).toEqual(held);
    unwrap(await data.requestErasure(f.a, ayesha));
    const waiting = await data.waitingErasures(f.a, { first: 10 });
    expect(waiting.items.map((item) => [item.customer.id, item.request.requestedBy])).toEqual([
      [ayesha, 'customer'],
    ]);
    expect((await f.accounts.account(f.a.shopId, token))!.dataRequests.erasure).toEqual(held);
    expect(await auditOf(ayesha)).toEqual([['customer.erasure_requested', 'customer', ayesha]]);

    // The order closed, it only waits for its day; and the shop may still cancel it.
    unwrap(await f.orders.cancel(f.a, placed.id, { reason: 'customer' }));
    expect((await f.accounts.account(f.a.shopId, token))!.dataRequests.erasure).toEqual({
      ...held,
      state: 'waiting',
    });
    unwrap(await data.cancelErasure(f.a, ayesha));
    expect((await f.accounts.account(f.a.shopId, token))!.dataRequests.erasure).toBeNull();

    // Asked for again, from the Urdu storefront, and carried out by the worker's sweep once due:
    // their file goes with them, as their session does.
    const asked = (await f.accounts.dataErase(f.a.shopId, token, 'ur-PK'))!;
    if (asked.state === 'none') throw new Error('Expected an erasure');
    expect(asked.state).toBe('waiting');
    await f.accounts.dataExport(f.a.shopId, token);
    const due = new Date(new Date(asked.eraseAfter).getTime() + 1_000);
    expect(await data.eraseDue(f.a.shopId, due)).toEqual({
      erased: 1,
      waiting: 0,
    });
    expect(await f.accounts.account(f.a.shopId, token)).toBeNull();
    expect(await f.accountData.deleteExpired()).toBe(1);
    expect(await files()).toEqual([]);
    expect((await auditOf(ayesha))[0]).toEqual(['customer.erased', 'customer', ayesha]);
    // And they are told so, at the number they signed in with, in Urdu (ADR-582).
    const { rows: told } = await f.admin.query(
      `SELECT recipient, language FROM messaging.messages WHERE kind = 'erasure_done'`,
    );
    expect(told).toEqual([{ recipient: JAZZ, language: 'ur' }]);
  });

  /** Products of `tenant`'s shop, by their titles: their IDs, in order. */
  const productsOf = async (titles: string[], tenant: TenantContext = f.a) =>
    (
      await f.admin.query<{ id: string }>(
        `INSERT INTO catalog.products (shop_id, title, handle, status)
         SELECT $1, title, 'product-' || gen_random_uuid(), 'active'
           FROM unnest($2::text[]) WITH ORDINALITY AS listed (title, position)
         ORDER BY position
         RETURNING id`,
        [tenant.shopId, titles],
      )
    ).rows.map((row) => row.id);

  /** The wishlists' items the shop keeps, as whose they are: a customer's, or a number's. */
  const wished = async () =>
    (
      await f.admin.query<{ owner: string; product_id: string }>(
        `SELECT coalesce(customer_id::text, phone) AS owner, product_id
           FROM checkout.account_wishlist_items ORDER BY owner, added_at DESC`,
      )
    ).rows.map((row) => [row.owner, row.product_id]);

  it("keeps a shopper's wishlist with their account, the newest first, in their shop alone (ADR-575)", async () => {
    const [kurta, shawl, dupatta, lawn] = (await productsOf([
      'Kurta',
      'Shawl',
      'Dupatta',
      'Lawn',
    ])) as [string, string, string, string];
    const [elsewhere] = (await productsOf(['Elsewhere'], f.b)) as [string];
    const placed = await order(JAZZ);
    const token = await signIn(JAZZ);
    expect(await f.accounts.wishlist(f.a.shopId, token)).toEqual([]);

    // A browser's list joins it as it was, the newest first; each again stays where it was.
    expect(await f.accounts.addToWishlist(f.a.shopId, token, [kurta, shawl])).toEqual([
      kurta,
      shawl,
    ]);
    expect(await f.accounts.addToWishlist(f.a.shopId, token, [dupatta])).toEqual([
      dupatta,
      kurta,
      shawl,
    ]);
    // Products the shop does not have, another shop's among them, are left out.
    expect(
      await f.accounts.addToWishlist(f.a.shopId, token, [shawl, lawn, elsewhere, kurta, newId()]),
    ).toEqual([lawn, dupatta, kurta, shawl]);
    expect(await f.accounts.wishlist(f.a.shopId, token)).toEqual([lawn, dupatta, kurta, shawl]);
    // Kept as the customer's, as every number of theirs reads it.
    expect(await wished()).toEqual([
      [placed.customerId, lawn],
      [placed.customerId, dupatta],
      [placed.customerId, kurta],
      [placed.customerId, shawl],
    ]);

    // Taken off, once; one not in it changes nothing.
    expect(await f.accounts.removeFromWishlist(f.a.shopId, token, dupatta)).toEqual([
      lawn,
      kurta,
      shawl,
    ]);
    expect(await f.accounts.removeFromWishlist(f.a.shopId, token, dupatta)).toEqual([
      lawn,
      kurta,
      shawl,
    ]);

    // A product the shop no longer has leaves it once it is read.
    await f.admin.query('DELETE FROM catalog.products WHERE id = $1', [kurta]);
    expect(await f.accounts.wishlist(f.a.shopId, token)).toEqual([lawn, shawl]);
    expect(await wished()).toEqual([
      [placed.customerId, lawn],
      [placed.customerId, shawl],
    ]);

    // Another session of the same number reads the same list; the same number in another shop
    // reads that shop's, and a session reads no other shop's.
    expect(await f.accounts.wishlist(f.a.shopId, await signIn(JAZZ))).toEqual([lawn, shawl]);
    const inB = await signIn(JAZZ, f.b);
    expect(await f.accounts.wishlist(f.b.shopId, inB)).toEqual([]);
    expect(await f.accounts.addToWishlist(f.b.shopId, inB, [elsewhere, lawn])).toEqual([elsewhere]);
    expect(await f.accounts.wishlist(f.b.shopId, token)).toBeNull();
    expect(await f.accounts.addToWishlist(f.b.shopId, token, [elsewhere])).toBeNull();
    expect(await f.accounts.wishlist(f.a.shopId, token)).toEqual([lawn, shawl]);

    // Without a session, nothing.
    expect(await f.accounts.wishlist(f.a.shopId, 'x'.repeat(43))).toBeNull();
    expect(await f.accounts.removeFromWishlist(f.a.shopId, 'nope', lawn)).toBeNull();
    await f.accounts.signOut(f.a.shopId, token);
    expect(await f.accounts.addToWishlist(f.a.shopId, token, [lawn])).toBeNull();
  });

  it('keeps the newest 100, the oldest going to make room (ADR-575)', async () => {
    const titles = Array.from({ length: 103 }, (_, index) => `Product ${index + 1}`);
    const products = await productsOf(titles);
    const token = await signIn(JAZZ);
    // The browser's list, the newest first: those past the 100th go.
    const kept = (await f.accounts.addToWishlist(f.a.shopId, token, products.slice(1, 102)))!;
    expect(kept).toEqual(products.slice(1, 101));
    // One more, and the oldest goes.
    expect(await f.accounts.addToWishlist(f.a.shopId, token, [products[0]!])).toEqual([
      products[0],
      ...products.slice(1, 100),
    ]);
    expect(await wished()).toHaveLength(100);
  });

  it("moves a number's own wishlist to the customer it becomes, joins merged customers' and erases it (ADR-575)", async () => {
    const [kurta, shawl, dupatta, lawn] = (await productsOf([
      'Kurta',
      'Shawl',
      'Dupatta',
      'Lawn',
    ])) as [string, string, string, string];
    // A number no customer has keeps its own list.
    const token = await signIn(JAZZ);
    expect(await f.accounts.addToWishlist(f.a.shopId, token, [kurta, shawl])).toEqual([
      kurta,
      shawl,
    ]);
    expect(await wished()).toEqual([
      [JAZZ, kurta],
      [JAZZ, shawl],
    ]);

    // Its first order makes it a customer's, whose list it becomes once read.
    const placed = await order(JAZZ);
    const ayesha = placed.customerId;
    expect(await f.accounts.wishlist(f.a.shopId, token)).toEqual([kurta, shawl]);
    expect(await wished()).toEqual([
      [ayesha, kurta],
      [ayesha, shawl],
    ]);

    // Another customer's list, on another number, joins hers when they are merged into her:
    // each product once, as it was added last.
    const zong = await signIn(ZONG);
    const bilal = (await order(ZONG)).customerId;
    expect(await f.accounts.addToWishlist(f.a.shopId, zong, [dupatta, kurta, lawn])).toEqual([
      dupatta,
      kurta,
      lawn,
    ]);
    unwrap(await data.merge(f.a, ayesha, bilal));
    expect(await f.accounts.wishlist(f.a.shopId, token)).toEqual([dupatta, kurta, lawn, shawl]);
    expect(await f.accounts.wishlist(f.a.shopId, zong)).toEqual([dupatta, kurta, lawn, shawl]);
    expect(await wished()).toHaveLength(4);
    // Merged again, nothing changes.
    await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.merge(tx, f.a.shopId, bilal, ayesha),
    );
    expect(await f.accounts.wishlist(f.a.shopId, token)).toEqual([dupatta, kurta, lawn, shawl]);

    // In her own file, the newest first.
    const filed = await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.export(tx, f.a.shopId, { id: ayesha, phones: [JAZZ], email: null }),
    );
    expect(filed.wishlist).toEqual(
      [dupatta, kurta, lawn, shawl].map((id) => ({
        productId: toPublicId('product', id),
        addedAt: expect.any(Date) as unknown,
      })),
    );

    // Erased, it goes, with the list a number of hers kept while it was no one's; another
    // shop's, and another number's, stay.
    const [elsewhere] = (await productsOf(['Elsewhere'], f.b)) as [string];
    await f.accounts.addToWishlist(f.b.shopId, await signIn(JAZZ, f.b), [elsewhere]);
    const other = await signIn('+923331234567');
    await f.accounts.addToWishlist(f.a.shopId, other, [lawn]);
    await f.admin.query(
      `INSERT INTO checkout.account_wishlist_items (shop_id, phone, product_id)
       VALUES ($1, $2, $3)`,
      [f.a.shopId, '+923009999999', shawl],
    );
    await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.erase(
        tx,
        f.a.shopId,
        { id: ayesha, phones: [JAZZ, '+923009999999'], email: null },
        'system',
      ),
    );
    expect(await wished()).toEqual([
      [JAZZ, elsewhere],
      ['+923331234567', lawn],
    ]);
  });

  it("sweeps a number's own wishlist once it is signed in nowhere (ADR-575)", async () => {
    const [kurta, shawl] = (await productsOf(['Kurta', 'Shawl'])) as [string, string];
    const jazz = await signIn(JAZZ);
    const zong = await signIn(ZONG);
    await f.accounts.addToWishlist(f.a.shopId, jazz, [kurta]);
    await f.accounts.addToWishlist(f.a.shopId, zong, [shawl, kurta]);
    // Signed in still: kept.
    expect(await f.expiry.deleteExpired()).toMatchObject({ wishlists: 0 });
    // Signed out, the number's last session takes its list with it.
    await f.accounts.signOut(f.a.shopId, zong);
    expect(await f.expiry.deleteExpired()).toMatchObject({ sessions: 1, wishlists: 2 });
    expect(await wished()).toEqual([[JAZZ, kurta]]);
    // A customer's is theirs whether or not they are signed in.
    await order(JAZZ);
    await f.accounts.wishlist(f.a.shopId, jazz);
    await f.accounts.signOut(f.a.shopId, jazz);
    expect(await f.expiry.deleteExpired()).toMatchObject({ sessions: 1, wishlists: 0 });
    expect(await wished()).toHaveLength(1);
  });

  /** An address as typed in the account's form. */
  const typed = (
    name: string,
    extra: Partial<AccountAddressRequest> = {},
  ): AccountAddressRequest => ({
    name,
    phone: '0300-1234567',
    address1: `${name}'s house, Street 4`,
    city: 'Lahore',
    ...extra,
  });

  /** The names in the book, the default marked with a star. */
  const names = (addresses: { name: string; default: boolean }[] | null | undefined) =>
    addresses?.map((address) => (address.default ? `*${address.name}` : address.name));

  /** Saves `input` to the book of the session `token`, expecting it saved: the names. */
  async function saved(token: string, input: AccountAddressRequest, id: string | null = null) {
    const result = await f.accounts.saveAddress(f.a.shopId, token, input, id);
    if (result?.kind !== 'saved') throw new Error(`Expected saved, got ${JSON.stringify(result)}`);
    return result.addresses;
  }

  it("keeps a customer's address book, the default first, checked as checkout's (ADR-583)", async () => {
    const token = await signIn(JAZZ);
    // A number no customer has keeps no book: its addresses come with its first order.
    expect(await f.accounts.addresses(f.a.shopId, token)).toEqual([]);
    expect(await f.accounts.saveAddress(f.a.shopId, token, typed('Home'), null)).toEqual({
      kind: 'invalid',
      errors: [
        expect.objectContaining({
          field: [],
          message: 'Your addresses are kept once you place your first order',
        }),
      ],
    });
    await order(JAZZ);

    // The first saved becomes the default, kept in checkout's shape.
    const [home] = await saved(token, typed('Home', { landmark: 'Near the mosque' }));
    expect(home).toEqual({
      id: expect.stringMatching(/^addr_/) as unknown,
      name: 'Home',
      phone: JAZZ,
      address1: "Home's house, Street 4",
      address2: null,
      landmark: 'Near the mosque',
      city: 'Lahore',
      provinceCode: 'PB',
      province: 'Punjab',
      zip: null,
      default: true,
    });
    // Another is not, unless asked.
    const office = (await saved(token, typed('Office'))).find((a) => a.name === 'Office')!;
    expect(names(await f.accounts.addresses(f.a.shopId, token))).toEqual(['*Home', 'Office']);
    expect(names(await saved(token, typed('Shop', { default: true })))).toEqual([
      '*Shop',
      'Office',
      'Home',
    ]);
    // Changed, it is the latest; made the default, it comes first.
    expect(names(await saved(token, typed('Office', { city: 'Karachi' }), office.id))).toEqual([
      '*Shop',
      'Office',
      'Home',
    ]);
    const changed = await saved(token, typed('Office', { default: true }), office.id);
    expect(names(changed)).toEqual(['*Office', 'Shop', 'Home']);
    expect(changed[0]).toMatchObject({ id: office.id, city: 'Lahore' });

    // What will not do, and addresses not in the book.
    expect(
      await f.accounts.saveAddress(
        f.a.shopId,
        token,
        typed('Bad', { city: '', phone: '123' }),
        null,
      ),
    ).toMatchObject({
      kind: 'invalid',
      errors: [
        expect.objectContaining({ field: ['phone'] }),
        expect.objectContaining({ field: ['city'] }),
      ],
    });
    for (const id of [toPublicId('accountAddress', newId()), 'nope']) {
      expect(await f.accounts.saveAddress(f.a.shopId, token, typed('Lost'), id)).toEqual({
        kind: 'invalid',
        errors: [expect.objectContaining({ field: ['id'], code: 'NOT_FOUND' })],
      });
    }
    // Another customer's is not in it either.
    const zong = await signIn(ZONG);
    await order(ZONG);
    expect(await f.accounts.saveAddress(f.a.shopId, zong, typed('Mine'), office.id)).toMatchObject({
      kind: 'invalid',
    });
    expect(await f.accounts.addresses(f.a.shopId, zong)).toEqual([]);
    expect(names(await f.accounts.deleteAddress(f.a.shopId, zong, office.id))).toEqual([]);

    // The default taken out, the newest left becomes it.
    expect(names(await f.accounts.deleteAddress(f.a.shopId, token, office.id))).toEqual([
      '*Shop',
      'Home',
    ]);
    expect(names(await f.accounts.deleteAddress(f.a.shopId, token, office.id))).toEqual([
      '*Shop',
      'Home',
    ]);
    expect(names(await f.accounts.deleteAddress(f.a.shopId, token, 'nope'))).toEqual([
      '*Shop',
      'Home',
    ]);

    // Without a session, or in another shop, nothing.
    expect(await f.accounts.addresses(f.b.shopId, token)).toBeNull();
    expect(await f.accounts.addresses(f.a.shopId, 'x'.repeat(43))).toBeNull();
    expect(await f.accounts.saveAddress(f.a.shopId, 'x'.repeat(43), typed('X'), null)).toBeNull();
    expect(await f.accounts.deleteAddress(f.a.shopId, 'x'.repeat(43), office.id)).toBeNull();
  });

  it(`keeps ${ACCOUNT_ADDRESSES_MAX} addresses at most (ADR-583)`, async () => {
    const token = await signIn(JAZZ);
    await order(JAZZ);
    for (let index = 1; index <= ACCOUNT_ADDRESSES_MAX; index += 1) {
      await saved(token, typed(`Address ${index}`));
    }
    const full = await f.accounts.saveAddress(f.a.shopId, token, typed('One more'), null);
    expect(full).toEqual({
      kind: 'invalid',
      errors: [expect.objectContaining({ field: [], code: 'TOO_MANY' })],
    });
    // One already in it can still change.
    const [first] = (await f.accounts.addresses(f.a.shopId, token))!;
    expect(await saved(token, typed('Changed'), first!.id)).toHaveLength(ACCOUNT_ADDRESSES_MAX);
  });

  it("fills brought customers' empty address books by their numbers, once (ONB-05, ADR-784)", async () => {
    const ayesha = unwrap(await customers.create(f.a, { phone: '0300 1234567', name: 'Ayesha' }));
    const bilal = unwrap(await customers.create(f.a, { phone: '0311 1234567', name: 'Bilal' }));
    await customers.create(f.b, { phone: '0300 1234567', name: 'Ayesha' });
    const books = [
      {
        phone: '+92 300 1234567',
        addresses: [typed('Office'), typed('Home', { default: true }), typed('Bad', { city: '' })],
      },
      // A number no customer has, and one no one could have, keep nothing.
      { phone: '0345 1234567', addresses: [typed('Nobody')] },
      { phone: 'none', addresses: [typed('Nobody')] },
      { phone: ZONG, addresses: [typed('Shop', { province: 'Sindh', city: 'Karachi' })] },
    ];
    expect(await f.accounts.bringAddresses(f.a.shopId, books)).toEqual({
      added: 3,
      problems: [{ book: 0, message: "City can't be blank" }],
    });
    const kept = await f.accounts.addressBooks(f.a.shopId, [ayesha.id, bilal.id]);
    expect(kept.get(ayesha.id)?.map((a) => [a.address.name, a.isDefault])).toEqual([
      ['Home', true],
      ['Office', false],
    ]);
    expect(kept.get(bilal.id)?.map((a) => a.address)).toEqual([
      expect.objectContaining({ name: 'Shop', city: 'Karachi', provinceCode: 'SD' }),
    ]);
    // Brought again, books with addresses are left as they are.
    expect(await f.accounts.bringAddresses(f.a.shopId, books)).toEqual({ added: 0, problems: [] });
    expect((await f.accounts.addressBooks(f.a.shopId, [ayesha.id])).get(ayesha.id)).toHaveLength(2);
  });

  it("joins merged customers' address books, gives them in their file and erases them (ADR-583)", async () => {
    const token = await signIn(JAZZ);
    const ayesha = (await order(JAZZ)).customerId;
    await saved(token, typed('Home'));
    const zong = await signIn(ZONG);
    const bilal = (await order(ZONG)).customerId;
    await saved(zong, typed('Office', { default: true }));
    await saved(zong, typed('Shop'));
    expect(names(await f.accounts.addresses(f.a.shopId, zong))).toEqual(['*Office', 'Shop']);

    // Merged into hers, his addresses join her book, her default staying.
    unwrap(await data.merge(f.a, ayesha, bilal));
    expect(names(await f.accounts.addresses(f.a.shopId, token))).toEqual([
      '*Home',
      'Shop',
      'Office',
    ]);
    expect(names(await f.accounts.addresses(f.a.shopId, zong))).toEqual([
      '*Home',
      'Shop',
      'Office',
    ]);

    // In her own file, the default first, without the IDs the storefront uses.
    const filed = await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.export(tx, f.a.shopId, { id: ayesha, phones: [JAZZ], email: null }),
    );
    expect(filed.addresses).toEqual(
      ['Home', 'Shop', 'Office'].map((name) => ({
        name,
        phone: JAZZ,
        address1: `${name}'s house, Street 4`,
        address2: null,
        landmark: null,
        city: 'Lahore',
        provinceCode: 'PB',
        province: 'Punjab',
        zip: null,
        default: name === 'Home',
        savedAt: expect.any(Date) as unknown,
        changedAt: expect.any(Date) as unknown,
      })),
    );

    // Erased, her book goes; another shop's stays.
    const [shawl] = (await f.variantsOf(f.b, 'Shawl', { price: '900' })) as [string];
    await f.stock(f.b, shawl, 10);
    const inB = await signIn(JAZZ, f.b);
    await order(JAZZ, f.b, shawl);
    expect(await f.accounts.saveAddress(f.b.shopId, inB, typed('Elsewhere'), null)).toMatchObject({
      kind: 'saved',
    });
    await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.erase(
        tx,
        f.a.shopId,
        { id: ayesha, phones: [JAZZ], email: null },
        'system',
      ),
    );
    const { rows } = await f.admin.query<{ name: string }>(
      `SELECT address ->> 'name' AS name FROM checkout.account_addresses`,
    );
    expect(rows).toEqual([{ name: 'Elsewhere' }]);
  });

  it("reads many customers' books at once for staff, the default first, and no other shop's (ADR-588)", async () => {
    const jazz = await signIn(JAZZ);
    const ayesha = (await order(JAZZ)).customerId;
    await saved(jazz, typed('Home'));
    await saved(jazz, typed('Office', { default: true }));
    const zong = await signIn(ZONG);
    const bilal = (await order(ZONG)).customerId;
    await saved(zong, typed('Shop'));
    const nobody = newId();

    const books = await f.accounts.addressBooks(f.a.shopId, [ayesha, bilal, nobody]);
    const shown = (id: string) =>
      books.get(id)?.map((record) => (record.isDefault ? '*' : '') + record.address.name);
    expect([shown(ayesha), shown(bilal), shown(nobody)]).toEqual([
      ['*Office', 'Home'],
      ['*Shop'],
      undefined,
    ]);
    expect((await f.accounts.addressBooks(f.b.shopId, [ayesha, bilal])).size).toBe(0);
    expect((await f.accounts.addressBooks(f.a.shopId, [])).size).toBe(0);
  });

  it("fills a signed-in shopper's checkout from their default address, or their number (ADR-585)", async () => {
    const token = await signIn(JAZZ);
    const formOf = async (account: string | null, tenant: TenantContext = f.a) => {
      const { secret } = await checkout(tenant);
      const view = await f.checkouts.view(secret, tenant.shopId, { account });
      if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
      return view.form;
    };
    // A number no customer has yet: the number it signed in with.
    expect(await formOf(token)).toMatchObject({ name: '', phone: '0300 1234567', city: '' });

    // Its default address once it keeps one.
    await order(JAZZ);
    await saved(token, typed('Home'));
    await saved(
      token,
      typed('Office', {
        phone: '0321 7654321',
        city: 'Karachi',
        landmark: 'Opposite the bank',
        default: true,
      }),
    );
    expect(await formOf(token)).toMatchObject({
      name: 'Office',
      phone: '0321 7654321',
      address1: "Office's house, Street 4",
      address2: '',
      landmark: 'Opposite the bank',
      city: 'Karachi',
      province: 'SD',
      payment: '',
      code: '',
    });

    // No session, another shop's, or one that is over: nothing filled in.
    const [shawl] = (await f.variantsOf(f.b, 'Shawl', { price: '900' })) as [string];
    await f.stock(f.b, shawl, 10);
    const inB = await signIn(JAZZ, f.b);
    for (const account of [null, inB, 'x'.repeat(43), 'y'.repeat(500)]) {
      expect(await formOf(account)).toMatchObject({ name: '', phone: '', city: '' });
    }
    await f.accounts.signOut(f.a.shopId, token);
    expect(await formOf(token)).toMatchObject({ name: '', phone: '' });
  });

  it("fills a checkout from what its cart permalink gives, over a signed-in shopper's address (ADR-709)", async () => {
    const formOf = async (prefill: Record<string, string>, account: string | null = null) => {
      const { secret } = await checkout();
      const view = await f.checkouts.view(secret, f.a.shopId, { account, prefill });
      if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
      return view.form;
    };
    expect(
      await formOf({
        name: ' Ayesha Khan ',
        phone: '0300 1234567',
        email: 'ayesha@example.pk',
        city: 'Lahore',
        address1: 'House 12, Street 4',
        address2: 'Gulberg',
        // Nothing else of the form is a link's to give.
        payment: 'bank_transfer',
        code: '123456',
      } as Record<string, string>),
    ).toMatchObject({
      name: 'Ayesha Khan',
      phone: '0300 1234567',
      email: 'ayesha@example.pk',
      city: 'Lahore',
      address1: 'House 12, Street 4',
      address2: 'Gulberg',
      payment: '',
      code: '',
    });
    // Each within what its field takes; a blank one gives nothing.
    const long = await formOf({ name: 'A'.repeat(300), city: '  ' });
    expect([long.name.length, long.city]).toEqual([200, '']);

    // Over a signed-in shopper's own address, field by field.
    const token = await signIn(JAZZ);
    await order(JAZZ);
    await saved(token, typed('Office', { city: 'Karachi', default: true }));
    expect(await formOf({ city: 'Lahore' }, token)).toMatchObject({
      name: 'Office',
      city: 'Lahore',
      address1: "Office's house, Street 4",
    });
  });

  it('takes a session signed in to the account as proof of its number when placing (ADR-586)', async () => {
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    const token = await signIn(JAZZ);
    const by = (account: string) => ({ client: { ip: null, userAgent: null, account } });
    // Its own number: placed without a code, proved when the session signed in with it.
    const own = await checkout();
    const placed = await f.checkouts.place(own.secret, own.shown, FORM, by(token));
    expect(placed.kind).toBe('placed');
    const { rows } = await f.admin.query<{ phone_verified_at: Date | null }>(
      'SELECT phone_verified_at FROM orders.orders',
    );
    expect(rows).toEqual([{ phone_verified_at: expect.any(Date) as unknown }]);
    expect(await sent('one_time_code')).toEqual([]);

    // Another number, another shop's session, one that is none or over: a code asked for.
    const inB = await signIn(JAZZ, f.b);
    const asked = async (phone: string, account: string) => {
      const { secret, shown } = await checkout();
      const view = await f.checkouts.place(secret, shown, { ...FORM, phone }, by(account));
      return view.kind === 'open' ? view.problem?.kind : view.kind;
    };
    expect(await asked(ZONG, token)).toBe('code');
    expect(await asked(JAZZ, inB)).toBe('code');
    expect(await asked(JAZZ, 'x'.repeat(43))).toBe('code');
    await f.accounts.signOut(f.a.shopId, token);
    expect(await asked(JAZZ, token)).toBe('code');
  });

  it("shows a signed-in shopper their number's store credit at checkout, not another's (ADR-592)", async () => {
    const token = await signIn(JAZZ);
    // No customer, or no credit: none.
    expect(await f.checkouts.creditOf(f.a.shopId, token)).toBeNull();
    const ayesha = (await order(JAZZ)).customerId;
    expect(await f.checkouts.creditOf(f.a.shopId, token)).toBeNull();
    unwrap(
      await credit.credit(f.a, { customerId: ayesha }, { amount: '750', currencyCode: 'PKR' }),
    );
    expect(await f.checkouts.creditOf(f.a.shopId, token)).toBe(750_00n);
    // Another shop's session, or none, reads none.
    expect(await f.checkouts.creditOf(f.b.shopId, token)).toBeNull();
    expect(await f.checkouts.creditOf(f.a.shopId, 'x'.repeat(43))).toBeNull();

    const { secret } = await checkout();
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error('Expected an open checkout');
    expect(view.storeCredit).toBe(true);
    expect(checkoutPage({ ...view, creditBalance: 750_00n }).html).toContain(
      'Your store credit: Rs 750',
    );
    expect(checkoutPage(view).html).not.toContain('Your store credit');
  });

  it("offers a signed-in shopper's saved addresses at checkout, filling in the one chosen (ADR-587)", async () => {
    const token = await signIn(JAZZ);
    const by = (account?: string) => ({
      shopId: f.a.shopId,
      client: { ip: null, userAgent: null, ...(account && { account }) },
    });
    await order(JAZZ);
    // No book yet: none offered.
    expect(await f.checkouts.book(f.a.shopId, token)).toBeNull();
    const [home] = await saved(token, typed('Home'));
    const office = (await saved(token, typed('Office', { city: 'Karachi' }))).find(
      (address) => address.name === 'Office',
    )!;
    const book = await f.checkouts.book(f.a.shopId, token);
    expect(book).toEqual([
      { id: home!.id, summary: "Home, Home's house, Street 4, Lahore", isDefault: true },
      { id: office.id, summary: "Office, Office's house, Street 4, Karachi", isDefault: false },
    ]);

    // Chosen, it fills in the form, placing nothing.
    const { secret } = await checkout();
    const chosen = await f.checkouts.useAddress(secret, office.id, by(token));
    expect(chosen).toMatchObject({
      kind: 'open',
      form: { name: 'Office', city: 'Karachi', province: 'SD', phone: '0300 1234567' },
      problem: null,
    });
    // The page offers each, with a form of its own, in place of asking for a code.
    if (chosen.kind !== 'open') throw new Error('Expected an open checkout');
    const page = checkoutPage({ ...chosen, book: book! });
    expect(page.html).toContain('Your saved addresses');
    expect(page.html).toContain(`name="address" value="${office.id}"`);
    expect(page.html.match(/value="use_address"/g)).toHaveLength(2);
    expect(page.html).not.toContain('Ordered here before?');
    expect(checkoutPage(chosen).html).toContain('Ordered here before?');

    // An address not in the book: the default; no session: nothing filled in.
    const lost = await f.checkouts.useAddress(
      secret,
      toPublicId('accountAddress', newId()),
      by(token),
    );
    expect(lost).toMatchObject({ form: { name: 'Home', city: 'Lahore' } });
    expect(await f.checkouts.useAddress(secret, 'nope', by(token))).toMatchObject({
      form: { name: 'Home' },
    });
    expect(await f.checkouts.useAddress(secret, office.id, by())).toMatchObject({
      form: { name: '', city: '' },
    });
    // Another customer's session reads no one else's book, nor another shop's.
    const zong = await signIn(ZONG);
    await order(ZONG);
    expect(await f.checkouts.book(f.a.shopId, zong)).toBeNull();
    expect(await f.checkouts.useAddress(secret, office.id, by(zong))).toMatchObject({
      form: { name: '', phone: '0311 1234567' },
    });
    expect(await f.checkouts.book(f.b.shopId, token)).toBeNull();
    expect(await f.checkouts.book(f.a.shopId, 'y'.repeat(500))).toBeNull();
  });

  it('sweeps codes to sign in with once their day is up', async () => {
    await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ });
    await f.accounts.startSignIn(f.a.shopId, { phone: ZONG });
    await f.admin.query(
      `UPDATE checkout.number_codes
          SET created_at = created_at - interval '25 hours',
              expires_at = expires_at - interval '25 hours'
        WHERE phone = $1`,
      [JAZZ],
    );
    expect(await f.expiry.deleteExpired()).toMatchObject({ codes: 1 });
    const { rows } = await f.admin.query<{ phone: string }>(
      'SELECT phone FROM checkout.number_codes',
    );
    expect(rows).toEqual([{ phone: ZONG }]);
  });
});
