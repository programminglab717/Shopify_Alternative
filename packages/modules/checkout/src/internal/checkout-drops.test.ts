import 'reflect-metadata';
import { DropService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutService, CheckoutView } from './checkout.service.js';
import { DropTokens, type DropTokenPool } from './drop-tokens.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

/** Pools kept in memory, as Valkey keeps them. */
class KeptTokens extends DropTokens {
  readonly left = new Map<string, number>();
  readonly givenBack: number[] = [];

  async take(pool: DropTokenPool, quantity: number, stock: () => Promise<number>) {
    const key = `${pool.dropId}:${pool.variantId}`;
    if (!this.left.has(key)) this.left.set(key, await stock());
    const left = this.left.get(key)!;
    if (left < quantity) return false;
    this.left.set(key, left - quantity);
    return true;
  }

  async giveBack(pool: DropTokenPool, quantity: number) {
    const key = `${pool.dropId}:${pool.variantId}`;
    this.left.set(key, (this.left.get(key) ?? 0) + quantity);
    this.givenBack.push(quantity);
  }
}

describe.skipIf(!server)('Checking out in a drop (INV-09, ADR-820)', () => {
  let f: CheckoutFixture;
  let lawn: string;
  let dropId: string;

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

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [lawn] = (await f.variantsOf(f.a, 'Lawn 3-piece', { price: '4,500' })) as [string];
    await f.stock(f.a, lawn, 100);
    const { rows } = await f.admin.query<{ product_id: string }>(
      'SELECT product_id FROM catalog.variants WHERE id = $1',
      [lawn],
    );
    const start = new Date(Date.now() + 3_600_000);
    dropId = unwrap(
      await new DropService(f.db).set(f.a, null, {
        name: 'Eid lawn',
        startsAt: start,
        endsAt: new Date(start.getTime() + 86_400_000),
        productIds: [rows[0]!.product_id],
        perCustomer: 2,
      }),
    ).id;
  });

  /** The drop started a minute ago, or ended a minute ago. */
  const live = () =>
    f.admin.query(
      "UPDATE catalog.drops SET starts_at = now() - interval '1 minute' WHERE id = $1",
      [dropId],
    );
  const over = () =>
    f.admin.query(
      `UPDATE catalog.drops SET starts_at = now() - interval '2 days',
                                ends_at = now() - interval '1 minute' WHERE id = $1`,
      [dropId],
    );

  const add = (quantity: number) => {
    const action = parseAction('add', { items: [{ variantId: lawn, quantity }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    return f.carts.act(f.a.shopId, null, action);
  };

  /** Places a cart of `quantity` for `phone`, through `checkouts`. */
  async function placed(
    quantity: number,
    phone: string,
    checkouts: CheckoutService = f.checkouts,
  ): Promise<CheckoutView> {
    const added = await add(quantity);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await checkouts.start(f.a.shopId, added.token!))!;
    const view = await checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return checkouts.place(secret, view.shown, { ...FORM, phone });
  }

  it('sells its products to no one before it starts', async () => {
    const early = await add(1);
    expect(early).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', variantId: lawn } });
  });

  it('sells each customer so many while it is live, by their number however written', async () => {
    await live();
    // A cart holds no more than a customer may buy.
    expect(await add(3)).toMatchObject({
      ok: false,
      error: { code: 'MAX_QUANTITY', variantId: lawn, max: 2 },
    });
    expect((await placed(2, '0300-1234567')).kind).toBe('placed');
    const again = await placed(1, '+92 300 1234567');
    expect(again).toMatchObject({
      kind: 'open',
      problem: { kind: 'drop_limit', title: 'Lawn 3-piece', limit: 2, had: 2 },
    });
    const page = checkoutPage(again);
    expect(page.html).toContain(
      'In this drop, each customer may buy 2 of Lawn 3-piece at most, and this number has ordered 2.',
    );
    // Another number buys its own.
    expect((await placed(2, '0321-7654321')).kind).toBe('placed');
  });

  it('counts no cancelled order, and limits no one once it is over', async () => {
    await live();
    const first = await placed(2, '0300-1234567');
    if (first.kind !== 'placed') throw new Error(first.kind);
    unwrap(await f.orders.cancel(f.a, first.order.id, { reason: 'customer' }));
    expect((await placed(2, '0300-1234567')).kind).toBe('placed');
    await over();
    expect((await placed(3, '0300-1234567')).kind).toBe('placed');
  });

  it("takes a live drop's units from its pool first, refusing at once once it is empty (ADR-821)", async () => {
    await live();
    await f.admin.query('UPDATE catalog.drops SET per_customer = NULL WHERE id = $1', [dropId]);
    const tokens = new KeptTokens();
    const checkouts = f.checkoutsWith(tokens);
    expect((await placed(2, '0300-1234567', checkouts)).kind).toBe('placed');
    // Started from the stock: 100, two of them taken.
    expect([...tokens.left.values()]).toEqual([98]);
    // Empty, the pool refuses before the stock is asked.
    tokens.left.set([...tokens.left.keys()][0]!, 1);
    const refused = await placed(2, '0321-7654321', checkouts);
    expect(refused).toMatchObject({ kind: 'open', problem: { kind: 'unavailable' } });
    const { rows } = await f.admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM orders.orders',
    );
    expect(rows[0]!.count).toBe(1);
    // The stock refuses what the pool let through: its tokens go back. Two carts of the last
    // unit, the first placed before the second.
    tokens.left.set([...tokens.left.keys()][0]!, 500);
    await f.admin.query(
      'UPDATE inventory.levels SET on_hand = committed + 1 WHERE variant_id = $1',
      [lawn],
    );
    const opened = async () => {
      const added = await add(1);
      if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
      const secret = (await checkouts.start(f.a.shopId, added.token!))!;
      const view = await checkouts.view(secret);
      if (view.kind !== 'open') throw new Error(view.kind);
      return { secret, shown: view.shown };
    };
    const first = await opened();
    const second = await opened();
    expect(
      (await checkouts.place(first.secret, first.shown, { ...FORM, phone: '0333-1112223' })).kind,
    ).toBe('placed');
    expect(
      await checkouts.place(second.secret, second.shown, { ...FORM, phone: '0345-9998887' }),
    ).toMatchObject({ kind: 'open', problem: { kind: 'unavailable' } });
    // Refused by its own stock before the pool is asked, the second takes no tokens.
    expect([...tokens.left.values()]).toEqual([499]);
    expect(tokens.givenBack).toEqual([]);

    // Undone after its tokens were taken, as when the shop asks for a code first, the order
    // gives them back.
    await f.admin.query(
      'UPDATE inventory.levels SET on_hand = committed + 5 WHERE variant_id = $1',
      [lawn],
    );
    unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
    const third = await opened();
    expect(
      await checkouts.place(third.secret, third.shown, { ...FORM, phone: '0312-4445556' }),
    ).toMatchObject({ kind: 'open', problem: { kind: 'code' } });
    expect(tokens.givenBack).toEqual([1]);
    expect([...tokens.left.values()]).toEqual([499]);
  });
});
