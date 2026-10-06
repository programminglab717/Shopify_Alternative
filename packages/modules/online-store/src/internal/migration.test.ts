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

describe.skipIf(!server)('migration 0035', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it('makes each policy kept so far its first version, as it was last saved', async () => {
    db = await createTestDatabase(server, { before: '0035' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    await admin.query(
      `INSERT INTO online_store.policies (shop_id, type, body, updated_at)
       VALUES ($1, 'refund_policy', '<p>7 days.</p>', '2026-09-01T10:00:00Z'),
              ($1, 'shipping_policy', '<p>Rs 250.</p>', '2026-09-02T10:00:00Z')`,
      [shop],
    );

    const result = await migrateThrough(db.adminUrl, '0035');
    expect(result.applied[0]).toBe('0035_e_contract_logs');

    const { rows } = await admin.query<{ type: string; body: string; saved: Date }>(
      `SELECT v.type, v.body, v.created_at AS saved
         FROM online_store.policies p
         JOIN online_store.policy_versions v ON v.shop_id = p.shop_id AND v.id = p.version_id
        ORDER BY v.type`,
    );
    expect(rows).toEqual([
      { type: 'refund_policy', body: '<p>7 days.</p>', saved: new Date('2026-09-01T10:00:00Z') },
      { type: 'shipping_policy', body: '<p>Rs 250.</p>', saved: new Date('2026-09-02T10:00:00Z') },
    ]);
    // Every policy has its version from now on.
    const missing = await admin
      .query(
        `INSERT INTO online_store.policies (shop_id, type, body) VALUES ($1, 'privacy_policy', 'x')`,
        [shop],
      )
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: '23502', column: 'version_id' });
  });
});
