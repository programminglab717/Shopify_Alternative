import { migrate } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const server = testDatabaseServer();

describe.skipIf(!server)('migration 0015', () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it('moves orders waiting to be fulfilled to To pack', async () => {
    // Orders as they were before packing, when confirmed orders waited in to_fulfill.
    db = await createTestDatabase(server, { before: '0015' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    const order = (number: number, confirmation: string, stage: string) =>
      admin!.query(
        `INSERT INTO orders.orders
           (shop_id, id, number, source, confirmation_status, financial_status, stage,
            payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
            phone, shipping_address, location_id, customer_id)
         VALUES ($1, $2, $3, 'online_store', $4, 'pending', $5, 'cash_on_delivery', 'PKR',
                 200000, 0, 0, 200000, 0, 200000, '+923001234567', '{}', $6, $7)`,
        [shop, newId(), number, confirmation, stage, newId(), newId()],
      );
    await order(1001, 'confirmed', 'to_fulfill');
    await order(1002, 'pending', 'needs_confirmation');

    const result = await migrate({ connectionString: db.adminUrl });
    expect(result.applied[0]).toBe('0015_packing');

    const { rows } = await admin.query<{ number: number; stage: string; packed_at: Date | null }>(
      'SELECT number, stage, packed_at FROM orders.orders ORDER BY number',
    );
    expect(rows).toEqual([
      { number: 1001, stage: 'to_pack', packed_at: null },
      { number: 1002, stage: 'needs_confirmation', packed_at: null },
    ]);
    const old = await admin
      .query(`UPDATE orders.orders SET stage = 'to_fulfill' WHERE number = 1001`)
      .catch((error: unknown) => error);
    expect(old).toMatchObject({ code: '23514', constraint: 'orders_stage_check' });
  });
});

describe.skipIf(!server)('migration 0040', () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it('gives addresses kept before no landmark, their second line as it was', async () => {
    db = await createTestDatabase(server, { before: '0040' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    const address = {
      name: 'Ayesha Khan',
      phone: '+923001234567',
      address1: 'House 12, Street 4, Block 5',
      address2: 'Near Jamia Masjid',
      city: 'Karachi',
      provinceCode: 'SD',
      zip: null,
    };
    await admin.query(
      `INSERT INTO orders.orders
         (shop_id, id, number, source, confirmation_status, financial_status, stage,
          payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
          phone, shipping_address, location_id, customer_id)
       VALUES ($1, $2, 1001, 'online_store', 'pending', 'pending', 'needs_confirmation',
               'cash_on_delivery', 'PKR', 200000, 0, 0, 200000, 0, 200000, '+923001234567', $3,
               $4, $5)`,
      [shop, newId(), address, newId(), newId()],
    );
    const draft = (number: number, shippingAddress: object | null) =>
      admin!.query(
        `INSERT INTO orders.draft_orders
           (shop_id, id, number, source, payment_method, currency, lines, subtotal, discount,
            shipping, total, advance_paid, phone, shipping_address, actor_kind, actor_id)
         VALUES ($1, $2, $3, 'whatsapp', 'cash_on_delivery', 'PKR', '[{}]', 200000, 0, 0,
                 200000, 0, $4, $5, 'app', $6)`,
        [shop, newId(), number, shippingAddress && address.phone, shippingAddress, newId()],
      );
    await draft(1, address);
    await draft(2, null);

    const result = await migrate({ connectionString: db.adminUrl });
    expect(result.applied[0]).toBe('0040_address_landmarks');

    const { rows } = await admin.query<{ shipping_address: unknown }>(
      `SELECT shipping_address FROM orders.orders
       UNION ALL (SELECT shipping_address FROM orders.draft_orders ORDER BY number)`,
    );
    expect(rows.map((row) => row.shipping_address)).toEqual([
      { ...address, landmark: null },
      { ...address, landmark: null },
      null,
    ]);
  });
});
