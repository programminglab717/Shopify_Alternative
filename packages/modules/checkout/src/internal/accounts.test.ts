import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { sha256 } from '@hatti/crypto';
import {
  CustomerDataRegistry,
  CustomerDataService,
  CustomerService,
  StoreCreditService,
} from '@hatti/customers/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { toPublicId } from '@hatti/ids';
import { ORDER_CUSTOMER_DATA } from '@hatti/orders/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_SESSION, type SignInVerify } from './account.service.js';
import { parseAction } from './cart-lines.js';
import type { CheckoutForm } from './checkout.service.js';
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
      storeCredit: { balance: 0, currency: 'PKR', expiring: null },
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
    });
    expect(account.storeCredit).toEqual({
      balance: 750_00,
      currency: 'PKR',
      expiring: { amount: 500_00, expiresAt: expect.any(String) as unknown },
    });

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
