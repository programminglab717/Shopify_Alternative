import {
  MIGRATION_TEST_TIMEOUT,
  createTestDatabase,
  migrateThrough,
  testDatabaseServer,
  type TestDatabase,
} from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const server = testDatabaseServer();

describe.skipIf(!server)('migration 0058', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
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

    const result = await migrateThrough(db.adminUrl, '0058');
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

describe.skipIf(!server)('migration 0063', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it('pays the claims of lost parcels with the cash statements imported before paid for them', async () => {
    db = await createTestDatabase(server, { before: '0063' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    /** An order of two items at Rs 1,000 in one parcel, `status`: the parcel's ID. */
    const parcel = async (number: number, status: 'lost' | 'delivered') => {
      const order = newId();
      await admin!.query(
        `INSERT INTO orders.orders
           (shop_id, id, number, source, confirmation_status, financial_status, stage,
            payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
            phone, shipping_address, location_id, customer_id)
         VALUES ($1, $2, $3, 'api', 'confirmed', 'voided', 'lost', 'cash_on_delivery',
                 'PKR', 200000, 0, 0, 200000, 0, 200000, '+923001234567', '{}', $4, $5)`,
        [shop, order, number, newId(), newId()],
      );
      const line = newId();
      await admin!.query(
        `INSERT INTO orders.lines
           (shop_id, id, order_id, position, variant_id, product_id, title, variant_title,
            quantity, unit_price, total)
         VALUES ($1, $2, $3, 1, $4, $5, 'Kurta', 'M', 2, 100000, 200000)`,
        [shop, line, order, newId(), newId()],
      );
      const id = newId();
      await admin!.query(
        `INSERT INTO orders.fulfillments
           (shop_id, id, order_id, location_id, status, lost_at, delivered_at)
         VALUES ($1, $2, $3, $4, $5::text, CASE WHEN $5 = 'lost' THEN now() END,
                 CASE WHEN $5 = 'delivered' THEN now() END)`,
        [shop, id, order, newId(), status],
      );
      await admin!.query(
        `INSERT INTO orders.fulfillment_lines (shop_id, fulfillment_id, line_id, quantity)
         VALUES ($1, $2, $3, 2)`,
        [shop, id, line],
      );
      return id;
    };
    const [paidLess, paidMore, chargedOnly, delivered] = [
      await parcel(1001, 'lost'),
      await parcel(1002, 'lost'),
      await parcel(1003, 'lost'),
      await parcel(1004, 'delivered'),
    ];
    /** A statement imported before: its ID, with lines of [parcel, outcome, collected]. */
    const statement = async (lines: [string, string, number][]) => {
      const id = newId();
      await admin!.query(
        `INSERT INTO logistics.cod_remittances
           (shop_id, id, courier, line_count, collected, charges, tax, paid, received, actor_kind,
            created_at)
         VALUES ($1, $2, 'TCS', $3, 0, 0, 0, 0, 0, 'staff', '2026-09-20T10:00:00Z')`,
        [shop, id, lines.length],
      );
      for (const [index, [fulfillmentId, outcome, collected]] of lines.entries()) {
        await admin!.query(
          `INSERT INTO logistics.cod_remittance_lines
             (shop_id, remittance_id, file_row, tracking_number, fulfillment_id, outcome,
              collected, charges, tax)
           VALUES ($1, $2, $3, 'TCS1', $4, $5, $6, 0, 0)`,
          [shop, id, index + 2, fulfillmentId, outcome, collected],
        );
      }
      return id;
    };
    const first = await statement([
      [paidLess, 'not_owed', 150000],
      [chargedOnly, 'charged', 0],
      [delivered, 'not_owed', 50000],
    ]);
    const second = await statement([
      [paidMore, 'not_owed', 250000],
      [paidLess, 'repeated', 150000],
    ]);

    const result = await migrateThrough(db.adminUrl, '0063');
    expect(result.applied[0]).toBe('0063_courier_claims');

    const { rows: lines } = await admin.query<{ fulfillment_id: string; outcome: string }>(
      `SELECT fulfillment_id, outcome FROM logistics.cod_remittance_lines
        ORDER BY remittance_id = $1 DESC, file_row`,
      [first],
    );
    expect(lines.map((line) => [line.fulfillment_id, line.outcome])).toEqual([
      [paidLess, 'compensated'],
      [chargedOnly, 'charged'],
      [delivered, 'not_owed'],
      [paidMore, 'compensated'],
      [paidLess, 'repeated'],
    ]);
    const { rows: claims } = await admin.query(
      `SELECT id, claim_status, claim_amount::text, claim_paid::text, claimed_at,
              claim_settled_at
         FROM orders.fulfillments ORDER BY id`,
    );
    const at = new Date('2026-09-20T10:00:00Z');
    expect(Object.fromEntries(claims.map(({ id, ...claim }) => [id, claim]))).toEqual({
      // Its worth, Rs 2,000, claimed; more paid, more claimed.
      [paidLess]: {
        claim_status: 'paid',
        claim_amount: '200000',
        claim_paid: '150000',
        claimed_at: at,
        claim_settled_at: at,
      },
      [paidMore]: {
        claim_status: 'paid',
        claim_amount: '250000',
        claim_paid: '250000',
        claimed_at: at,
        claim_settled_at: at,
      },
      [chargedOnly]: {
        claim_status: null,
        claim_amount: null,
        claim_paid: null,
        claimed_at: null,
        claim_settled_at: null,
      },
      [delivered]: {
        claim_status: null,
        claim_amount: null,
        claim_paid: null,
        claimed_at: null,
        claim_settled_at: null,
      },
    });
    const { rows: statements } = await admin.query<{ id: string; compensated: string }>(
      'SELECT id, compensated::text FROM logistics.cod_remittances',
    );
    expect(Object.fromEntries(statements.map((row) => [row.id, row.compensated]))).toEqual({
      [first]: '150000',
      [second]: '250000',
    });
  });
});
