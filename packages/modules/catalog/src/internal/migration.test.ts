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

describe.skipIf(!server)('migration 0004', () => {
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

  it('gives products that had several variants a Title option, so each stays distinct', async () => {
    // A database as it was before options existed: migrations up to 0003.
    dir = await mkdtemp(join(tmpdir(), 'hatti-migrations-'));
    for (const file of await readdir(defaultMigrationsDir)) {
      if (file < '0004') await copyFile(join(defaultMigrationsDir, file), join(dir, file));
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

    const result = await migrate({ connectionString: withDatabase(server!, name) });
    expect(result.applied[0]).toBe('0004_catalog_depth');

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
