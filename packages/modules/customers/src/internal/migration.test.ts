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

describe.skipIf(!server)('migration 0013', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it("registers every existing customer's number", async () => {
    // A database with customers, as it was before they could have several numbers.
    db = await createTestDatabase(server, { before: '0013' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    const [ayesha, bilal] = [newId(), newId()];
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    await admin.query(
      `INSERT INTO customers.customers (shop_id, id, phone)
       VALUES ($1, $2, '+923001234567'), ($1, $3, '+923335551234')`,
      [shop, ayesha, bilal],
    );

    const result = await migrateThrough(db.adminUrl, '0013');
    expect(result.applied[0]).toBe('0013_customer_numbers_merge_erasure');

    const { rows } = await admin.query<{ phone: string; customer_id: string }>(
      'SELECT phone, customer_id FROM customers.customer_phones ORDER BY phone',
    );
    expect(rows).toEqual([
      { phone: '+923001234567', customer_id: ayesha },
      { phone: '+923335551234', customer_id: bilal },
    ]);
    // A customer's main number must be registered to them.
    const unregistered = await admin
      .query(
        `INSERT INTO customers.customers (shop_id, id, phone) VALUES ($1, $2, '+923451234567')`,
        [shop, newId()],
      )
      .catch((error: unknown) => error);
    expect(unregistered).toMatchObject({ code: '23503', constraint: 'customers_phone_registered' });
  });
});
