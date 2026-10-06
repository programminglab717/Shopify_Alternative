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

describe.skipIf(!server)('migration 0004', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it('gives products that had several variants a Title option, so each stays distinct', async () => {
    // A database as it was before options existed: migrations up to 0003.
    db = await createTestDatabase(server, { before: '0004' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    const [chappal, ajrak] = [newId(), newId()];
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    await admin.query(
      `INSERT INTO catalog.products (shop_id, id, title, handle)
       VALUES ($1, $2, 'Chappal', 'chappal'), ($1, $3, 'Ajrak', 'ajrak')`,
      [shop, chappal, ajrak],
    );
    await admin.query(
      `INSERT INTO catalog.variants (shop_id, product_id, title, price, position)
       VALUES ($1, $2, 'Size 8', 100, 1), ($1, $2, 'Size 9', 100, 2), ($1, $2, 'size 9', 100, 3),
              ($1, $3, 'Default', 200, 1)`,
      [shop, chappal, ajrak],
    );

    // 0004 alone: those after it are other tests', and more of them come with each change.
    const result = await migrateThrough(db.adminUrl, '0004');
    expect(result.applied).toEqual(['0004_catalog_depth']);

    const { rows } = await admin.query<{
      product: string;
      option: string | null;
      value: string | null;
    }>(
      `SELECT p.handle AS product, o.name AS option, ov.name AS value
         FROM catalog.variants v
         JOIN catalog.products p ON p.shop_id = v.shop_id AND p.id = v.product_id
         LEFT JOIN catalog.product_option_values ov
           ON ov.shop_id = v.shop_id AND ov.id = v.option1_value_id
         LEFT JOIN catalog.product_options o ON o.shop_id = ov.shop_id AND o.id = ov.option_id
        ORDER BY p.handle, v.position`,
    );
    expect(rows).toEqual([
      { product: 'ajrak', option: null, value: null },
      { product: 'chappal', option: 'Title', value: 'Size 8' },
      { product: 'chappal', option: 'Title', value: 'Size 9 2' },
      { product: 'chappal', option: 'Title', value: 'size 9 3' },
    ]);
  });
});
