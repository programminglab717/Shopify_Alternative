import 'reflect-metadata';
import { sha256 } from '@hatti/crypto';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { CHECKOUT_CUSTOMER_DATA } from './customer-data.js';
import { NUMBER_CODE } from './number-codes.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Codes that prove the number at checkout', () => {
  let f: CheckoutFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
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

  /** A checkout of a kurta: its secret and what its page showed. */
  async function checkout() {
    const action = parseAction('add', { items: [{ variantId: kurta, quantity: 1 }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return { secret, shown: view.shown };
  }

  const problemOf = (view: CheckoutView) =>
    view.kind === 'open' ? view.problem : view.kind === 'placed' ? null : view.kind;

  /** The codes sent, the newest last, as their messages hold them until they are sent. */
  const sent = async () =>
    (
      await f.admin.query<{ channel: string; recipient: string; code: string | null }>(
        `SELECT channel, recipient, variables ->> 'code' AS code FROM messaging.messages
          WHERE kind = 'one_time_code' ORDER BY created_at, id`,
      )
    ).rows;

  const orders = async () =>
    (
      await f.admin.query<{ id: string; phone_verified_at: Date | null }>(
        'SELECT id, phone_verified_at FROM orders.orders',
      )
    ).rows;

  it('asks for a code where the shop does, and places the order once the number is proved', async () => {
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    const { secret, shown } = await checkout();
    const asked = await f.checkouts.place(secret, shown, FORM);
    expect(problemOf(asked)).toEqual({
      kind: 'code',
      phone: '0300 ••••567',
      channel: 'whatsapp',
      state: 'sent',
    });
    // Nothing placed yet; the code on its way, on WhatsApp, as the shop's.
    expect(await orders()).toEqual([]);
    const [code] = await sent();
    expect(code).toMatchObject({ channel: 'whatsapp', recipient: '+923001234567' });
    expect(code!.code).toMatch(/^\d{6}$/);
    // The page asks for it, and keeps what was typed.
    const page = checkoutPage(asked);
    expect(page.status).toBe(200);
    expect(page.html).toContain('name="code"');
    expect(page.html).toContain('autocomplete="one-time-code"');
    expect(page.html).toContain('value="sms"');
    expect(page.html).toContain('value="Ayesha Khan"');

    const wrong = String((Number(code!.code) + 1) % 10 ** 6).padStart(6, '0');
    const refused = await f.checkouts.place(secret, shown, { ...FORM, code: wrong });
    expect(problemOf(refused)).toMatchObject({ kind: 'code', state: 'wrong' });
    expect(checkoutPage(refused).status).toBe(422);

    const placed = await f.checkouts.place(secret, shown, { ...FORM, code: ` ${code!.code} ` });
    expect(placed.kind).toBe('placed');
    const [order] = await orders();
    expect(order!.phone_verified_at).toBeInstanceOf(Date);
    const { rows: created } = await f.admin.query<{ message: string }>(
      `SELECT message FROM orders.order_events WHERE order_id = $1 AND kind = 'created'`,
      [order!.id],
    );
    expect(created[0]!.message).toMatch(
      /^Order #\d+ placed from the online store, its number proved/,
    );
  });

  it('spares a browser that proved the number lately another code, for 30 days (ADR-199)', async () => {
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    const from = (proof: string) => ({ client: { ip: null, userAgent: null, proof } });
    // Proved by a code: the order placed gives the browser a proof for its cookie.
    const first = await checkout();
    await f.checkouts.place(first.secret, first.shown, FORM);
    const [code] = await sent();
    const placed = await f.checkouts.place(first.secret, first.shown, {
      ...FORM,
      code: code!.code!,
    });
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    const proof = placed.proof!;
    expect(proof).toMatch(/^[\w-]{22}$/);
    // Only its digest is kept, with the number it proves.
    const { rows: kept } = await f.admin.query<{ phone: string; token_hash: Buffer }>(
      'SELECT phone, token_hash FROM checkout.number_proofs',
    );
    expect(kept).toEqual([{ phone: '+923001234567', token_hash: sha256(proof) }]);

    // The next checkout from that browser places at once, as proved then; no code is sent.
    const second = await checkout();
    const spared = await f.checkouts.place(second.secret, second.shown, FORM, from(proof));
    expect(spared.kind).toBe('placed');
    expect(spared.kind === 'placed' && spared.proof).toBeUndefined();
    expect(await sent()).toHaveLength(1);
    const proved = (await orders()).map((order) => order.phone_verified_at?.getTime());
    expect(proved).toEqual([proved[0], proved[0]]);

    // Another number, a token that is none, or a proof gone past its 30 days: asked again.
    const third = await checkout();
    const other = { ...FORM, phone: '0300-7654321' };
    expect(
      problemOf(await f.checkouts.place(third.secret, third.shown, other, from(proof))),
    ).toMatchObject({ kind: 'code', phone: '0300 ••••321' });
    const fourth = await checkout();
    expect(
      problemOf(await f.checkouts.place(fourth.secret, fourth.shown, FORM, from('x'.repeat(22)))),
    ).toMatchObject({ kind: 'code' });
    // A customer's own file says when their number was proved; erased, its proof goes.
    const identity = { id: 'not-needed', phones: ['+923001234567'], email: null };
    const filed = await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.export(tx, f.a.shopId, identity),
    );
    expect(filed).toEqual({
      numberProofs: [
        {
          number: '+923001234567',
          provedAt: new Date(proved[0]!),
          sparesCodesUntil: new Date(proved[0]! + 30 * 86_400_000),
        },
      ],
    });
    await f.admin.query(
      `UPDATE checkout.number_proofs
          SET proved_at = proved_at - interval '30 days', expires_at = expires_at - interval '30 days'`,
    );
    const fifth = await checkout();
    expect(
      problemOf(await f.checkouts.place(fifth.secret, fifth.shown, FORM, from(proof))),
    ).toMatchObject({ kind: 'code' });
    await f.db.tenant(f.a.shopId, (tx) =>
      CHECKOUT_CUSTOMER_DATA.erase(tx, f.a.shopId, identity, 'system'),
    );
    expect((await f.admin.query('SELECT 1 FROM checkout.number_proofs')).rows).toEqual([]);
  });

  it('sends another by SMS, or anew, the last stopping, for ten minutes and five tries', async () => {
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    const { secret, shown } = await checkout();
    await f.checkouts.place(secret, shown, FORM);
    const bySms = await f.checkouts.place(secret, shown, { ...FORM, resend: 'sms' });
    expect(problemOf(bySms)).toMatchObject({ kind: 'code', channel: 'sms', state: 'sent' });
    expect(checkoutPage(bySms).html).toContain('value="whatsapp"');
    const [first, second] = await sent();
    expect(second!.channel).toBe('sms');
    // The first no longer works.
    if (first!.code !== second!.code) {
      expect(
        problemOf(await f.checkouts.place(secret, shown, { ...FORM, code: first!.code! })),
      ).toMatchObject({ state: 'wrong' });
    }
    // Ten minutes on: too late.
    await f.admin.query(
      `UPDATE checkout.number_codes SET expires_at = now() - interval '1 second'`,
    );
    expect(
      problemOf(await f.checkouts.place(secret, shown, { ...FORM, code: second!.code! })),
    ).toMatchObject({ kind: 'code', channel: 'sms', state: 'expired' });

    // A new one, tried five times wrong: no more tries at it.
    await f.checkouts.place(secret, shown, { ...FORM, resend: 'whatsapp' });
    for (let attempt = 1; attempt <= NUMBER_CODE.attempts; attempt++) {
      const view = await f.checkouts.place(secret, shown, { ...FORM, code: '000000x' });
      expect(problemOf(view)).toMatchObject({
        state: attempt < NUMBER_CODE.attempts ? 'wrong' : 'too_many',
      });
    }
    const [, , third] = await sent();
    expect(
      problemOf(await f.checkouts.place(secret, shown, { ...FORM, code: third!.code! })),
    ).toMatchObject({ state: 'too_many' });
    expect(await orders()).toEqual([]);

    // Five codes a checkout at most.
    await f.checkouts.place(secret, shown, { ...FORM, resend: 'sms' });
    await f.checkouts.place(secret, shown, { ...FORM, resend: 'sms' });
    const tooMany = await f.checkouts.place(secret, shown, { ...FORM, resend: 'sms' });
    expect(problemOf(tooMany)).toMatchObject({ kind: 'code', state: 'too_many' });
    expect(checkoutPage(tooMany).status).toBe(429);
    expect(checkoutPage(tooMany).html).not.toContain('name="code"');
    expect(await sent()).toHaveLength(NUMBER_CODE.perCheckout);
  });

  it('sends one internet address at most 20 codes an hour, across checkouts and numbers (ADR-249)', async () => {
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    const client = { ip: '203.0.113.7', userAgent: 'Test' };
    const first = await checkout();
    await f.checkouts.place(first.secret, first.shown, FORM, { client });
    const kept = async () =>
      (
        await f.admin.query<{ ip: string | null }>(
          'SELECT host(ip) AS ip FROM checkout.number_codes ORDER BY created_at, id',
        )
      ).rows.map((row) => row.ip);
    expect(await kept()).toEqual(['203.0.113.7']);
    // Nineteen more lately from the address, to other numbers.
    await f.admin.query(
      `INSERT INTO checkout.number_codes (shop_id, checkout_id, phone, channel, code_hash,
                                          expires_at, ip)
       SELECT shop_id, checkout_id, '+92300765' || lpad(n::text, 4, '0'), 'whatsapp', code_hash,
              expires_at, ip
         FROM checkout.number_codes, generate_series(1, 19) AS n`,
    );
    const next = await checkout();
    const other = { ...FORM, phone: '0321-7654321' };
    const refused = await f.checkouts.place(next.secret, next.shown, other, { client });
    expect(problemOf(refused)).toMatchObject({ kind: 'code', state: 'too_many' });
    expect(checkoutPage(refused).status).toBe(429);
    // Another address is sent one; so is this one, an hour on.
    const elsewhere = await f.checkouts.place(next.secret, next.shown, other, {
      client: { ...client, ip: '2001:db8::1' },
    });
    expect(problemOf(elsewhere)).toMatchObject({ kind: 'code', state: 'sent' });
    await f.admin.query(
      `UPDATE checkout.number_codes SET created_at = created_at - interval '61 minutes'
        WHERE host(ip) = '203.0.113.7'`,
    );
    const later = await f.checkouts.place(next.secret, next.shown, other, { client });
    expect(problemOf(later)).toMatchObject({ kind: 'code', state: 'sent' });
    // What isn't an address is kept as none, and counts for nothing.
    const unknown = await f.checkouts.place(
      next.secret,
      next.shown,
      { ...other, resend: 'sms' },
      { client: { ...client, ip: 'unknown' } },
    );
    expect(problemOf(unknown)).toMatchObject({ kind: 'code', state: 'sent' });
    expect((await kept()).slice(-3)).toEqual(['2001:db8::1', '203.0.113.7', null]);
    expect(await sent()).toHaveLength(4);
  });

  it('asks only of orders paid on delivery scored at the shop’s mark, and only once proved', async () => {
    // No mark: no code.
    let { secret, shown } = await checkout();
    expect((await f.checkouts.place(secret, shown, FORM)).kind).toBe('placed');
    // Scored below the mark: none either.
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0.95 }));
    ({ secret, shown } = await checkout());
    expect((await f.checkouts.place(secret, shown, { ...FORM, phone: '0321-7654321' })).kind).toBe(
      'placed',
    );
    expect(await sent()).toEqual([]);
    expect((await orders()).map((order) => order.phone_verified_at)).toEqual([null, null]);

    // Proved for one number: another typed after needs its own.
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    ({ secret, shown } = await checkout());
    await f.checkouts.place(secret, shown, { ...FORM, phone: '0333-5550001' });
    const [code] = await sent();
    const other = await f.checkouts.place(secret, shown, {
      ...FORM,
      phone: '0333-5550002',
      code: code!.code!,
    });
    expect(problemOf(other)).toMatchObject({ kind: 'code', state: 'expired' });
  });
});
