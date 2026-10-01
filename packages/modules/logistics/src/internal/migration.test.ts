import { migrate } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const server = testDatabaseServer();

describe.skipIf(!server)('migration 0058', () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it('charges parcels what the statements imported before charged them', async () => {
    db = await createTestDatabase(server, { before: '0058' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    /** An order with one parcel: the parcel's ID. */
    const parcel = async (number: number) => {
      const order = newId();
      await admin!.query(
        `INSERT INTO orders.orders
           (shop_id, id, number, source, confirmation_status, financial_status, stage,
            payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
            phone, shipping_address, location_id, customer_id)
         VALUES ($1, $2, $3, 'api', 'confirmed', 'pending', 'in_transit', 'cash_on_delivery',
                 'PKR', 200000, 0, 0, 200000, 0, 200000, '+923001234567', '{}', $4, $5)`,
        [shop, order, number, newId(), newId()],
      );
      const id = newId();
      await admin!.query(
        `INSERT INTO orders.fulfillments (shop_id, id, order_id, location_id)
         VALUES ($1, $2, $3, $4)`,
        [shop, id, order, newId()],
      );
      return id;
    };
    const [sentBack, delivered, uncharged] = [
      await parcel(1001),
      await parcel(1002),
      await parcel(1003),
    ];
    /** A statement imported before, with lines of [parcel, outcome, collected, charges]. */
    const statement = async (lines: [string | null, string, number, number][]) => {
      const id = newId();
      await admin!.query(
        `INSERT INTO logistics.cod_remittances
           (shop_id, id, courier, line_count, collected, charges, tax, paid, received, actor_kind)
         VALUES ($1, $2, 'TCS', $3, 0, 0, 0, 0, 0, 'staff')`,
        [shop, id, lines.length],
      );
      for (const [index, [fulfillmentId, outcome, collected, charges]] of lines.entries()) {
        await admin!.query(
          `INSERT INTO logistics.cod_remittance_lines
             (shop_id, remittance_id, file_row, tracking_number, fulfillment_id, outcome,
              collected, charges, tax)
           VALUES ($1, $2, $3, 'TCS1', $4, $5, $6, $7, 0)`,
          [shop, id, index + 2, fulfillmentId, outcome, collected, charges],
        );
      }
    };
    // Out: one delivered with its cash, one sent back, and a line that matched nothing.
    await statement([
      [delivered, 'received', 200000, 15000],
      [sentBack, 'charged', 0, 15000],
      [null, 'unmatched', 50000, 10000],
    ]);
    // Back, in two lines; and the delivered parcel's cash again, its charges with it before.
    await statement([
      [sentBack, 'charged', 0, 12000],
      [delivered, 'repeated', 200000, 15000],
      [sentBack, 'repeated', 0, 3000],
    ]);

    const result = await migrate({ connectionString: db.adminUrl });
    expect(result.applied[0]).toBe('0058_return_costs');

    const { rows } = await admin.query<{ id: string; courier_charges: string | null }>(
      'SELECT id, courier_charges::text FROM orders.fulfillments',
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.courier_charges]))).toEqual({
      [sentBack]: '30000',
      [delivered]: '15000',
      [uncharged]: null,
    });
    const digests = await admin.query('SELECT digest FROM logistics.cod_remittances');
    expect(digests.rows).toEqual([{ digest: null }, { digest: null }]);
  });
});
