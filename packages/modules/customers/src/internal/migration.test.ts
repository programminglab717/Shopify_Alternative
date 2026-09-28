import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultMigrationsDir,
  migrate,
  setupDatabase,
  withCredentials,
  withDatabase,
} from '@hatti/db';
import { TEST_LOGINS, testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const server = testDatabaseServer();

describe.skipIf(!server)('migration 0013', () => {
  const name = `hatti_test_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client | undefined;
  let dir: string | undefined;

  afterAll(async () => {
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
    const cleanup = new pg.Client({ connectionString: server });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${cleanup.escapeIdentifier(name)} WITH (FORCE)`);
    await cleanup.end();
  });

  it("registers every existing customer's number", async () => {
    // A database with customers, as it was before they could have several numbers.
    dir = await mkdtemp(join(tmpdir(), 'hatti-migrations-'));
    for (const file of await readdir(defaultMigrationsDir)) {
      if (file < '0013') await copyFile(join(defaultMigrationsDir, file), join(dir, file));
    }
    const login = (kind: keyof typeof TEST_LOGINS) =>
      withCredentials(
        withDatabase(server!, name),
        TEST_LOGINS[kind].user,
        TEST_LOGINS[kind].password,
      );
    await setupDatabase({
      adminUrl: server!,
      appUrl: login('app'),
      systemUrl: login('system'),
      identityUrl: login('identity'),
      migrationsDir: dir,
    });
    admin = new pg.Client({ connectionString: withDatabase(server!, name) });
    await admin.connect();

    const shop = newId();
    const [ayesha, bilal] = [newId(), newId()];
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    await admin.query(
      `INSERT INTO customers.customers (shop_id, id, phone)
       VALUES ($1, $2, '+923001234567'), ($1, $3, '+923335551234')`,
      [shop, ayesha, bilal],
    );

    const result = await migrate({ connectionString: withDatabase(server!, name) });
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
