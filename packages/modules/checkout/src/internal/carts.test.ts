import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { TenantContext } from '@hatti/api';
import { sha256 } from '@hatti/crypto';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { CartActionName } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import type { CartResult } from './cart.service.js';
import { carts } from './schema.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('CartService', () => {
  let f: CheckoutFixture;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  /** Does what a storefront would post, as the controller checks it. */
  async function act(
    owner: TenantContext,
    token: string | null,
    name: CartActionName,
    body: unknown,
  ): Promise<CartResult> {
    const action = parseAction(name, body);
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    return f.carts.act(owner.shopId, token, action);
  }

  function done(result: CartResult) {
    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    return result;
  }

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(carts).limit(1));
  });

  it('keeps a cart by its secret, of which only the digest is kept', async () => {
    const [small, medium] = await f.variantsOf(f.a, 'Lawn 3-piece', {
      sizes: ['S', 'M'],
      price: '4,500',
    });
    const added = done(
      await act(f.a, null, 'add', {
        items: [
          { variantId: small, quantity: 2 },
          { variantId: medium, properties: { Stitching: 'Yes' } },
        ],
      }),
    );
    expect(added.token).toMatch(/^[\w-]{22}$/);
    expect(added.added).toHaveLength(2);
    const cart = await f.carts.cart(f.a.shopId, added.token!);
    expect(cart).toEqual(added.cart);
    expect(
      cart!.items.map((item) => [item.variantTitle, item.quantity, item.price, item.properties]),
    ).toEqual([
      ['S', 2, 450_000, {}],
      ['M', 1, 450_000, { Stitching: 'Yes' }],
    ]);
    expect([cart!.itemCount, cart!.subtotal]).toEqual([3, 1_350_000]);

    const { rows } = await f.admin.query<{ token_hash: Buffer; expires_in: number }>(
      `SELECT token_hash, extract(epoch FROM expires_at - now()) / 86400 AS expires_in
         FROM checkout.carts`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.equals(sha256(added.token!))).toBe(true);
    expect(Math.round(rows[0]!.expires_in)).toBe(14);

    // The same cart after another change; nothing for other shops, or secrets it never gave.
    const again = done(await act(f.a, added.token, 'add', { items: [{ variantId: small }] }));
    expect([again.token, again.cart.itemCount]).toEqual([added.token, 4]);
    expect(await f.carts.cart(f.b.shopId, added.token!)).toBeNull();
    expect(await f.carts.cart(f.a.shopId, 'A'.repeat(22))).toBeNull();
    expect(await f.carts.cart(f.a.shopId, "' OR 1=1 --")).toBeNull();
    const seen = await f.db.tenant(f.b.shopId, (tx) => tx.select().from(carts));
    expect(seen).toEqual([]);
  });

  it('prices a cart as the catalog prices it now, leaving out what is no longer for sale', async () => {
    const [lawn] = await f.variantsOf(f.a, 'Lawn 3-piece', { price: '4,500' });
    const [shawl] = await f.variantsOf(f.a, 'Shawl', { price: '3,000' });
    const { token } = done(
      await act(f.a, null, 'add', {
        items: [
          { variantId: lawn, quantity: 2 },
          { variantId: shawl, quantity: 1 },
        ],
      }),
    );
    const cart = await f.carts.cart(f.a.shopId, token!);
    const lawnProduct = cart!.items.find((item) => item.variantId === lawn)!.productId;
    const shawlProduct = cart!.items.find((item) => item.variantId === shawl)!.productId;

    unwrap(await f.variants.bulkUpdate(f.a, lawnProduct, [{ id: lawn!, price: '3,999' }]));
    unwrap(await f.products.update(f.a, { id: shawlProduct, status: 'draft' }));
    const now = await f.carts.cart(f.a.shopId, token!);
    expect(now!.items.map((item) => [item.title, item.price, item.linePrice])).toEqual([
      ['Lawn 3-piece', 399_900, 799_800],
    ]);
    expect(now!.subtotal).toBe(799_800);
    // Adding it again is refused, as for a product that never was.
    expect(await act(f.a, token, 'add', { items: [{ variantId: shawl }] })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', variantId: shawl },
    });
    // The next change drops its line for good, so it stays out when the product is back.
    done(await act(f.a, token, 'change', { line: { index: 1 }, quantity: 1 }));
    unwrap(await f.products.update(f.a, { id: shawlProduct, status: 'active' }));
    expect((await f.carts.cart(f.a.shopId, token!))!.items.map((item) => item.title)).toEqual([
      'Lawn 3-piece',
    ]);
  });

  it('holds a cart to the stock that can be sold online', async () => {
    const [tracked] = await f.variantsOf(f.a, 'Lawn 3-piece');
    const [untracked] = await f.variantsOf(f.a, 'Shawl');
    await f.stock(f.a, tracked!, 3);
    const { token } = done(
      await act(f.a, null, 'add', { items: [{ variantId: tracked, quantity: 2 }] }),
    );
    expect(await act(f.a, token, 'add', { items: [{ variantId: tracked, quantity: 2 }] })).toEqual({
      ok: false,
      error: { code: 'MAX_QUANTITY', variantId: tracked, title: 'Lawn 3-piece', max: 3 },
    });
    done(await act(f.a, token, 'add', { items: [{ variantId: untracked, quantity: 500 }] }));

    // Sold elsewhere since: the line keeps its quantity, and says how many can be bought.
    await f.stock(f.a, tracked!, 1);
    const cart = await f.carts.cart(f.a.shopId, token!);
    expect(cart!.items.map((item) => [item.title, item.quantity, item.maxQuantity])).toEqual([
      ['Shawl', 500, null],
      ['Lawn 3-piece', 2, 1],
    ]);
    // It can go down, not up.
    done(await act(f.a, token, 'change', { line: { variantId: tracked }, quantity: 1 }));
    expect(await act(f.a, token, 'change', { line: { variantId: tracked }, quantity: 2 })).toEqual({
      ok: false,
      error: { code: 'MAX_QUANTITY', variantId: tracked, title: 'Lawn 3-piece', max: 1 },
    });
  });

  it('makes a new cart for a secret naming none, but none that holds nothing', async () => {
    const [lawn] = await f.variantsOf(f.a, 'Lawn 3-piece');
    // Nothing to keep: no cart, no secret.
    expect(await act(f.a, null, 'clear', {})).toMatchObject({ ok: true, token: null });
    expect(await act(f.a, null, 'update', { updates: [] })).toMatchObject({ token: null });
    expect(await act(f.a, null, 'change', { line: { index: 1 }, quantity: 1 })).toEqual({
      ok: false,
      error: { code: 'LINE_NOT_FOUND' },
    });
    const noted = done(await act(f.a, null, 'update', { note: 'Deliver after 5' }));
    expect(noted.token).not.toBeNull();

    // An expired cart is gone; a secret naming none is never taken up.
    await f.admin.query(`UPDATE checkout.carts SET expires_at = now() - interval '1 second'`);
    expect(await f.carts.cart(f.a.shopId, noted.token!)).toBeNull();
    const fresh = done(await act(f.a, noted.token, 'add', { items: [{ variantId: lawn }] }));
    expect(fresh.token).not.toBe(noted.token);
    expect(fresh.cart.note).toBe('');
    // The expired one is left to the worker's sweep (ADR-230).
    expect(await f.expiry.deleteExpired()).toEqual({ checkouts: 0, carts: 1, proofs: 0 });
    const { rows } = await f.admin.query<{ count: string }>(`SELECT count(*) FROM checkout.carts`);
    expect(rows[0]!.count).toBe('1');
  });

  it('leaves what expired to the sweep, which deletes it across shops, the longest expired first', async () => {
    const at = Date.now();
    const hours = (n: number) => new Date(at + n * 3_600_000).toISOString();
    const ids = {
      oldA: newId(),
      staleA: newId(),
      liveA: newId(),
      oldB: newId(),
      oldCheckout: newId(),
      liveCheckout: newId(),
      ongoing: newId(),
    };
    const cart = (shopId: string, id: string, expires: number) =>
      f.admin.query(
        `INSERT INTO checkout.carts (shop_id, id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [shopId, id, randomBytes(32), hours(expires)],
      );
    const checkout = (id: string, cartId: string, expires: number) =>
      f.admin.query(
        `INSERT INTO checkout.checkouts (shop_id, id, token_hash, cart_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [f.a.shopId, id, randomBytes(32), cartId, hours(expires)],
      );
    const proof = async (shopId: string, expires: number) => {
      const { rows } = await f.admin.query<{ id: string }>(
        `INSERT INTO checkout.number_proofs (shop_id, token_hash, phone, proved_at, expires_at)
         VALUES ($1, $2, '+923001234567', $3::timestamptz - interval '30 days', $3)
         RETURNING id`,
        [shopId, randomBytes(32), hours(expires)],
      );
      return rows[0]!.id;
    };
    await cart(f.a.shopId, ids.oldA, -3);
    await cart(f.a.shopId, ids.staleA, -1);
    await cart(f.a.shopId, ids.liveA, 5);
    await cart(f.b.shopId, ids.oldB, -4);
    await checkout(ids.oldCheckout, ids.oldA, -2);
    await checkout(ids.liveCheckout, ids.liveA, 1);
    // A checkout outlasting its cart.
    await checkout(ids.ongoing, ids.staleA, 20);
    await f.admin.query(
      `INSERT INTO checkout.number_codes (shop_id, checkout_id, phone, channel, code_hash, expires_at)
       VALUES ($1, $2, '+923001234567', 'whatsapp', $3, $4)`,
      [f.a.shopId, ids.oldCheckout, randomBytes(32), hours(-2)],
    );
    const oldProofA = await proof(f.a.shopId, -1);
    const liveProof = await proof(f.a.shopId, 240);
    await proof(f.b.shopId, -2);
    const left = async () => {
      const idsOf = async (table: string) =>
        (
          await f.admin.query<{ id: string }>(
            `SELECT id FROM checkout.${table} ORDER BY expires_at`,
          )
        ).rows.map((row) => row.id);
      return {
        carts: await idsOf('carts'),
        checkouts: await idsOf('checkouts'),
        codes: await idsOf('number_codes'),
        proofs: await idsOf('number_proofs'),
      };
    };

    // The longest expired of each kind first, whichever shop's; a checkout's codes go with it.
    expect(await f.expiry.deleteExpired(new Date(at), 1)).toEqual({
      checkouts: 1,
      carts: 1,
      proofs: 1,
    });
    expect(await left()).toEqual({
      carts: [ids.oldA, ids.staleA, ids.liveA],
      checkouts: [ids.liveCheckout, ids.ongoing],
      codes: [],
      proofs: [oldProofA, liveProof],
    });
    // Then the rest; what has time left stays, and a checkout outlasting its cart goes on without
    // it.
    expect(await f.expiry.deleteExpired(new Date(at))).toEqual({
      checkouts: 0,
      carts: 2,
      proofs: 1,
    });
    expect(await left()).toEqual({
      carts: [ids.liveA],
      checkouts: [ids.liveCheckout, ids.ongoing],
      codes: [],
      proofs: [liveProof],
    });
    const { rows } = await f.admin.query<{ id: string; cart_id: string | null }>(
      'SELECT id, cart_id FROM checkout.checkouts ORDER BY expires_at',
    );
    expect(rows).toEqual([
      { id: ids.liveCheckout, cart_id: ids.liveA },
      { id: ids.ongoing, cart_id: null },
    ]);
    expect(await f.expiry.deleteExpired(new Date(at))).toEqual({
      checkouts: 0,
      carts: 0,
      proofs: 0,
    });
  });

  it('lets actions on one cart take turns', async () => {
    const [lawn] = await f.variantsOf(f.a, 'Lawn 3-piece');
    const { token } = done(await act(f.a, null, 'add', { items: [{ variantId: lawn }] }));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => act(f.a, token, 'add', { items: [{ variantId: lawn }] })),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await f.carts.cart(f.a.shopId, token!))!.items[0]!.quantity).toBe(11);
  });

  it("keeps the discount code Shopify's `discount` gives, and says what it takes off", async () => {
    const [lawn] = await f.variantsOf(f.a, 'Lawn 3-piece', { price: '4,000' });
    await f.stock(f.a, lawn!, 5);
    unwrap(await f.codes.create(f.a, { code: 'EID10', percentage: 10, minimumSubtotal: '5,000' }));
    // A code alone is something to keep: a /discount/ link before anything is added.
    const coded = done(await act(f.a, null, 'update', { discount: 'eid10' }));
    expect(coded.token).not.toBeNull();
    expect([coded.cart.discount, coded.cart.totalDiscount]).toEqual([
      // Under its minimum while the cart is empty: kept, taking nothing off yet, and said no more
      // of than a code the shop lacks.
      { code: 'eid10', applicable: false, kind: null, value: 0, amount: 0 },
      0,
    ]);
    const token = coded.token!;
    const added = done(await act(f.a, token, 'add', { items: [{ variantId: lawn, quantity: 2 }] }));
    expect([added.cart.discount, added.cart.totalDiscount]).toEqual([
      { code: 'EID10', applicable: true, kind: 'percentage', value: 10, amount: 800_00 },
      800_00,
    ]);
    expect((await f.carts.cart(f.a.shopId, token))?.totalDiscount).toBe(800_00);

    // The first code of those given that a shop could have; one it does not have, kept as typed.
    const other = done(await act(f.a, token, 'update', { discount: 'not a code, NOPE, EID10' }));
    expect(other.cart.discount).toEqual({
      code: 'NOPE',
      applicable: false,
      kind: null,
      value: 0,
      amount: 0,
    });
    expect(done(await act(f.a, token, 'update', { discount: '' })).cart.discount).toBeNull();
    // Left out, the code stays as it is.
    done(await act(f.a, token, 'update', { discount: 'EID10' }));
    expect(done(await act(f.a, token, 'update', { note: 'Gift' })).cart.discount?.code).toBe(
      'EID10',
    );
    expect(parseAction('update', { discount: 5 })).toMatchObject({ code: 'INVALID' });
  });
});
