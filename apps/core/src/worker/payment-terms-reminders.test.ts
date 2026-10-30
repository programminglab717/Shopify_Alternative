import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { BankTransferService, OrderSettingsService, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentTermsReminders } from './payment-terms-reminders.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_orders', 'write_settings']),
  };
}

describe.skipIf(!server)('Customers on payment terms reminded (ADR-945, ADR-954)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let sweeps: PaymentTermsReminders;
  const [a, b] = [tenant(newId()), tenant(newId())];
  const variants = new Map<string, string>();
  let phones = 0;

  /** An order of `owner`'s on payment terms, placed `daysAgo` days ago and due in `days` from then. */
  async function onTerms(owner: TenantContext, daysAgo: number, days = 10): Promise<string> {
    const order = unwrap(
      await orders.create(owner, {
        lineItems: [{ variantId: variants.get(owner.shopId)!, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: `0300 55566${String(phones++).padStart(2, '0')}`,
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
        paymentMethod: 'bank_transfer',
        paymentTermsDays: days,
      }),
    );
    await admin.query(
      `UPDATE orders.orders SET created_at = now() - make_interval(days => $2),
              payment_due_at = now() - make_interval(days => $2) + make_interval(days => $3)
        WHERE id = $1`,
      [order.id, daysAgo, days],
    );
    return order.id;
  }

  const reminded = async (id: string) =>
    (
      await admin.query<{ terms_reminded: number }>(
        'SELECT terms_reminded FROM orders.orders WHERE id = $1',
        [id],
      )
    ).rows[0]!.terms_reminded;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'payment-terms-reminders-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    orders = workerOrders(database);
    sweeps = new PaymentTermsReminders(database);
    const products = new ProductService(database);
    const locations = new LocationService(database);
    const inventory = new InventoryService(database, new VariantService(database));
    const transfers = new BankTransferService(database);
    for (const owner of [a, b]) {
      const product = unwrap(
        await products.create(owner, {
          title: 'Kurta',
          status: 'active',
          variants: [{ price: '2,000' }],
        }),
      );
      const variantId = product.variants[0]!.id;
      variants.set(owner.shopId, variantId);
      const location = await locations.primary(owner);
      unwrap(
        await inventory.setQuantities(owner, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 20 }],
        }),
      );
      unwrap(
        await transfers.update(owner, {
          enabled: true,
          account: {
            title: 'Zari Textiles',
            bankName: 'Standard Chartered',
            iban: 'PK36SCBL0000001123456702',
          },
        }),
      );
    }
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  it("reminds each shop's customers owing on terms, near the date and past it, and no one else", async () => {
    // Due in two days, a's; ten days past due, b's; due in eight days, not yet; paid, never.
    const near = await onTerms(a, 8);
    const late = await onTerms(b, 20);
    const early = await onTerms(a, 2);
    const paid = await onTerms(b, 9);
    unwrap(await orders.markAsPaid(b, paid));
    expect(await sweeps.sweep()).toBe(2);
    expect(await Promise.all([near, late, early, paid].map(reminded))).toEqual([1, 2, 0, 0]);
    // Each once.
    expect(await sweeps.sweep()).toBe(0);
    // Past its date, the one reminded before is reminded again, once.
    expect(await sweeps.sweep(new Date(Date.now() + 4 * 86_400_000))).toBe(1);
    expect(await reminded(near)).toBe(2);
    const { rows } = await admin.query<{ aggregate_id: string; payload: { overdue: boolean } }>(
      `SELECT aggregate_id, payload FROM platform.outbox_events
        WHERE event_type = 'order.payment_terms_reminded' ORDER BY occurred_at, id`,
    );
    expect(rows.map((row) => [row.aggregate_id, row.payload.overdue]).sort()).toEqual(
      [
        [near, false],
        [late, true],
        [near, true],
      ].sort(),
    );

    // Still owed, each is reminded again weekly, four times past its date in all (ADR-954).
    const day = 86_400_000;
    const weeks = [8, 15, 22, 29, 36].map((days) => new Date(Date.now() + days * day));
    const counts: number[][] = [];
    for (const at of weeks) {
      await sweeps.sweep(at);
      counts.push(await Promise.all([near, late].map(reminded)));
    }
    // The late one a week after its last, then weekly; the near one a week after its first past due.
    expect(counts).toEqual([
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 5],
      [5, 5],
    ]);
    const { rows: weekly } = await admin.query<{ payload: { reminder?: number } }>(
      `SELECT payload FROM platform.outbox_events
        WHERE event_type = 'order.payment_terms_reminded' AND aggregate_id = $1
        ORDER BY occurred_at, id`,
      [late],
    );
    expect(weekly.map((row) => row.payload.reminder ?? 1)).toEqual([1, 2, 3, 4]);
  });

  it('reminds as often, and as many times, as the shop chose (ADR-964)', async () => {
    // a's: every three days, twice past the date.
    unwrap(
      await new OrderSettingsService(database).update(a, {
        termsReminderDays: 3,
        termsOverdueReminders: 2,
      }),
    );
    const late = await onTerms(a, 20);
    const day = 86_400_000;
    const counts: number[] = [];
    for (const days of [0, 2, 3, 6, 9]) {
      await sweeps.sweep(new Date(Date.now() + days * day + 60_000));
      counts.push(await reminded(late));
    }
    // Overdue at once, again three days on, and no more.
    expect(counts).toEqual([2, 2, 3, 3, 3]);
    expect(
      (await new OrderSettingsService(database).update(a, { termsOverdueReminders: 5 })).ok,
    ).toBe(false);
  });
});
