import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { PriceListService } from '@hatti/pricing/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentTermsService } from './payment-terms.service.js';
import { termsOwed } from './rules.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();
const DAY_MS = 86_400_000;

describe('What an order on payment terms owes (ADR-888)', () => {
  const at = new Date('2026-11-15T00:00:00Z');
  const order = (paid: bigint, due: string | null, status: 'open' | 'cancelled' = 'open') => ({
    status,
    total: 500_000n,
    amountPaid: paid,
    paymentDueAt: due ? new Date(due) : null,
  });

  it('is its total less what came, overdue past its due date, nothing once paid or cancelled', () => {
    expect(termsOwed(order(0n, null), at)).toBeNull();
    expect(termsOwed(order(200_000n, '2026-11-30T00:00:00Z'), at)).toEqual({
      owed: 300_000n,
      overdue: false,
    });
    expect(termsOwed(order(0n, '2026-11-01T00:00:00Z'), at)).toEqual({
      owed: 500_000n,
      overdue: true,
    });
    expect(termsOwed(order(500_000n, '2026-11-01T00:00:00Z'), at)).toEqual({
      owed: 0n,
      overdue: false,
    });
    expect(termsOwed(order(0n, '2026-11-01T00:00:00Z', 'cancelled'), at)).toEqual({
      owed: 0n,
      overdue: false,
    });
  });
});

describe.skipIf(!server)('Orders on payment terms (CUS-06, ADR-888)', () => {
  let f: OrdersFixture;
  let terms: PaymentTermsService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    terms = new PaymentTermsService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  const onTerms = (phone: string, days: number | null) =>
    f.order(f.a, [kurta, kurta], {
      shippingAddress: { ...ADDRESS, phone },
      paymentMethod: 'bank_transfer',
      paymentTermsDays: days,
    });

  it('ships an order on terms without waiting for its transfer, owed until paid', async () => {
    const before = Date.now();
    const placed = await onTerms('0300-1111111', 30);
    // Not waiting for the money: it goes to be packed.
    expect(placed).toMatchObject({
      stage: 'to_pack',
      confirmationStatus: 'not_required',
      paymentTermsDays: 30,
    });
    const due = placed.paymentDueAt!.getTime();
    expect(due).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(due).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    // Without terms, a transfer is waited for, as before.
    expect((await onTerms('0300-1111111', null)).stage).toBe('awaiting_payment');

    // Terms are for paying by transfer, 1 to 120 days.
    for (const [extra, field] of [
      [{ paymentMethod: 'cash_on_delivery', paymentTermsDays: 30 }, 'paymentTermsDays'],
      [{ paymentMethod: 'bank_transfer', paymentTermsDays: 121 }, 'paymentTermsDays'],
    ] as const) {
      const refused = await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: ADDRESS,
        ...extra,
      });
      expect(errorsOf(refused)).toEqual([[`input.${field}`, 'INVALID']]);
    }
  });

  it('lists who owes, the most overdue first, and finds the orders owed or overdue', async () => {
    const late = await onTerms('0300-1111111', 15);
    const later = await onTerms('0300-1111111', 30);
    const other = await onTerms('0300-2222222', 30);
    // One of the first customer's is past its due date.
    await f.admin.query(
      `UPDATE orders.orders SET payment_due_at = now() - interval '2 days' WHERE id = $1`,
      [late.id],
    );
    // The other customer paid half of theirs.
    unwrap(await f.orders.recordPayment(f.a, other.id, { amount: '2,000' }));

    const owed = await terms.owed(f.a, { first: 10 });
    expect(owed).toMatchObject({ owed: 1_000_000n, overdue: 400_000n });
    expect(owed.customers.map((each) => [each.orders, each.owed, each.overdue])).toEqual([
      [2, 800_000n, 400_000n],
      [1, 200_000n, 0n],
    ]);
    expect(owed.customers[0]!.oldestDueAt.getTime()).toBeLessThan(Date.now());

    const found = async (query: string) =>
      (await f.orders.list(f.a, { first: 10, query })).items.map((each) => each.id).sort();
    expect(await found('payment_terms:overdue')).toEqual([late.id]);
    expect(await found('payment_terms:owed')).toEqual([late.id, later.id, other.id].sort());
    // Paid in full, it is owed no more.
    unwrap(await f.orders.markAsPaid(f.a, late.id));
    expect(await found('payment_terms:overdue')).toEqual([]);
    expect((await terms.owed(f.a, { first: 10 })).overdue).toBe(0n);
  });

  it("gives a wholesale customer's draft their price list's terms, and its order them", async () => {
    unwrap(
      await new PriceListService(f.db).create(f.a, {
        name: 'Wholesale',
        customerTag: 'wholesale',
        paymentTermsDays: 45,
      }),
    );
    unwrap(await f.customers.create(f.a, { phone: ADDRESS.phone, tags: ['wholesale'] }));
    const draft = (extra: Record<string, unknown>) =>
      f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 3 }],
        shippingAddress: ADDRESS,
        ...extra,
      });
    // Paid by transfer, on the list's terms; on delivery, none.
    const transfer = unwrap(await draft({ paymentMethod: 'bank_transfer' }));
    expect(transfer.paymentTermsDays).toBe(45);
    expect(unwrap(await draft({})).paymentTermsDays).toBeNull();
    // Terms of its own, or none.
    expect(
      unwrap(await draft({ paymentMethod: 'bank_transfer', paymentTermsDays: 7 })).paymentTermsDays,
    ).toBe(7);
    expect(
      unwrap(await draft({ paymentMethod: 'bank_transfer', paymentTermsDays: 0 })).paymentTermsDays,
    ).toBeNull();
    expect(errorsOf(await draft({ paymentTermsDays: 30 }))).toEqual([
      ['input.paymentTermsDays', 'INVALID'],
    ]);
    // Paid otherwise now, its terms go.
    const changed = unwrap(
      await f.drafts.update(f.a, transfer.id, { paymentMethod: 'cash_on_delivery' }),
    );
    expect(changed.paymentTermsDays).toBeNull();

    const kept = unwrap(await draft({ paymentMethod: 'bank_transfer' }));
    const completed = unwrap(await f.drafts.complete(f.a, kept.id));
    const placed = await f.orders.get(f.a, completed.orderId!);
    expect(placed).toMatchObject({ paymentTermsDays: 45, stage: 'to_pack' });
  });
});
