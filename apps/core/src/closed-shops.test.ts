import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantContext } from '@hatti/api';
import { MediaService, ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSED_SHOP_KEPT_DAYS, ClosedShopData, KEPT_ON_CLOSING } from './closed-shops.js';

const server = testDatabaseServer();
const DAY_MS = 86_400_000;

describe.skipIf(!server)("A closed shop's data deleted 90 days after it closed (ADR-741)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let directory: string;
  let storage: LocalStorage;
  let data: ClosedShopData;
  const closedAt = new Date('2026-07-01T10:00:00Z');
  const gone = newId();
  const open = newId();

  const tenantOf = (shopId: string): TenantContext => ({
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products']),
  });

  /** A product with a photo, a customer with a number, an order of the product, and a file. */
  async function stock(shopId: string): Promise<void> {
    const product = await new ProductService(database).create(tenantOf(shopId), {
      title: 'Lawn Kurta',
    });
    if (!product.ok) throw new Error('no product');
    const media = await new MediaService(database, storage).create(
      tenantOf(shopId),
      product.value.id,
      [{ originalSource: 'https://cdn.example.pk/kurta.jpg' }],
    );
    if (!media.ok) throw new Error('no media');
    const customer = newId();
    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO customers.customers (shop_id, id, phone) VALUES ($1, $2, '+923001234567')`,
      [shopId, customer],
    );
    await admin.query(
      `INSERT INTO customers.customer_phones (shop_id, phone, customer_id)
       VALUES ($1, '+923001234567', $2)`,
      [shopId, customer],
    );
    await admin.query('COMMIT');
    const order = newId();
    await admin.query(
      `INSERT INTO orders.orders
         (shop_id, id, number, source, confirmation_status, financial_status, stage,
          payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
          phone, shipping_address, location_id, customer_id)
       VALUES ($1, $2, 1001, 'online_store', 'pending', 'pending', 'needs_confirmation',
               'cash_on_delivery', 'PKR', 350000, 0, 0, 350000, 0, 350000, '+923001234567', '{}',
               $3, $4)`,
      [shopId, order, newId(), customer],
    );
    await admin.query(
      `INSERT INTO orders.lines
         (shop_id, id, order_id, position, variant_id, product_id, title, variant_title,
          quantity, unit_price, total)
       VALUES ($1, $2, $3, 1, $4, $5, 'Lawn Kurta', 'M', 1, 350000, 350000)`,
      [shopId, newId(), order, newId(), product.value.id],
    );
    await storage.put(`shops/${shopId}/files/logo.png`, Buffer.from('logo'), 'image/png');
  }

  const count = async (table: string, shopId: string) =>
    (
      await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE shop_id = $1`,
        [shopId],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'closed-shops-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, status, closed_at)
       VALUES ($1, 'Gone', 'gone', 'closed', $3), ($2, 'Zari', 'zari', 'active', NULL)`,
      [gone, open, closedAt],
    );
    directory = await mkdtemp(join(tmpdir(), 'hatti-closed-shops-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost:4000/storage',
      secret: 's'.repeat(32),
    });
    data = new ClosedShopData(database, storage);
    await stock(gone);
    await stock(open);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the records the law has Hatti keep, deletes the rest and its files, then marks it', async () => {
    const due = new Date(closedAt.getTime() + CLOSED_SHOP_KEPT_DAYS * DAY_MS);
    // Not before its 90 days are up, while its owner may still reopen it.
    expect(await data.due(new Date(due.getTime() - 1))).toEqual([]);
    expect(await data.purge(gone, new Date(due.getTime() - 1))).toBeNull();
    expect(await data.due(due)).toEqual([{ id: gone, name: 'Gone', closedAt }]);
    // An open shop is never due.
    expect(await data.purge(open, due)).toBeNull();

    const report = await data.report(gone);
    expect(report).toEqual(
      expect.arrayContaining([
        { table: 'catalog.products', rows: 1, kept: null },
        { table: 'customers.customers', rows: 1, kept: null },
        { table: 'orders.orders', rows: 1, kept: KEPT_ON_CLOSING['orders.orders'] },
        { table: 'orders.lines', rows: 1, kept: KEPT_ON_CLOSING['orders.lines'] },
      ]),
    );

    const purged = await data.purge(gone, due);
    expect(purged?.blocked).toEqual([]);
    expect(purged?.deleted).toMatchObject({
      'catalog.products': 1,
      'catalog.product_media': 1,
      // Added by deleting the photo, and deleted on the pass after.
      'catalog.media_removals': 1,
      'customers.customers': 1,
    });
    expect(await count('catalog.media_removals', gone)).toBe(0);
    for (const table of [
      'catalog.products',
      'catalog.product_media',
      'customers.customers',
      'customers.customer_phones',
    ]) {
      expect(await count(table, gone), table).toBe(0);
      expect(await count(table, open), table).toBeGreaterThan(0);
    }
    // Sales and what they sold stay, for tax.
    expect(await count('orders.orders', gone)).toBe(1);
    expect(await count('orders.lines', gone)).toBe(1);
    expect(await storage.head(`shops/${gone}/files/logo.png`)).toBeNull();
    expect(await storage.head(`shops/${open}/files/logo.png`)).not.toBeNull();

    const { rows } = await admin.query<{ status: string; purged_at: Date | null }>(
      'SELECT status, purged_at FROM control.shops WHERE id = $1',
      [gone],
    );
    expect(rows[0]).toEqual({ status: 'closed', purged_at: due });
    // Done once: no longer due, nor purged again.
    expect(await data.due(new Date(due.getTime() + DAY_MS))).toEqual([]);
    expect(await data.purge(gone, new Date(due.getTime() + DAY_MS))).toBeNull();
  });

  it('never lets identity reopen a shop whose data is gone, nor change it', async () => {
    await admin.query('SET ROLE hatti_identity_role');
    try {
      const reopened = await admin.query(
        `UPDATE control.shops SET status = 'active', closed_at = NULL WHERE id = $1`,
        [gone],
      );
      expect(reopened.rowCount).toBe(0);
      const developed = await admin.query(
        `UPDATE control.shops SET development = false WHERE id = $1`,
        [gone],
      );
      expect(developed.rowCount).toBe(0);
    } finally {
      await admin.query('RESET ROLE');
    }
    // And a purged shop can only be closed.
    const reopened = await admin
      .query(`UPDATE control.shops SET status = 'active', closed_at = NULL WHERE id = $1`, [gone])
      .catch((error: unknown) => error);
    expect(reopened).toMatchObject({ code: '23514', constraint: 'shops_purged' });
  });
});
