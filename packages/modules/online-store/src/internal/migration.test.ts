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

describe.skipIf(!server)('migration 0164', { timeout: MIGRATION_TEST_TIMEOUT }, () => {
  let db: TestDatabase | undefined;
  let admin: pg.Client | undefined;

  afterAll(async () => {
    await admin?.end();
    await db?.drop();
  });

  it('forgets the translations of what was deleted before it, and of what is deleted after', async () => {
    db = await createTestDatabase(server, { before: '0164' });
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();

    const shop = newId();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old shop')`, [shop]);
    const [page, menu, home, sale] = [newId(), newId(), newId(), newId()];
    // Gone before: a product, and an item dropped from the menu.
    const [product, dropped] = [newId(), newId()];
    await admin.query(
      `INSERT INTO online_store.pages (shop_id, id, handle, title)
       VALUES ($1, $2, 'about-us', 'About us')`,
      [shop, page],
    );
    const items = [
      {
        id: home,
        title: 'Home',
        type: 'frontpage',
        items: [{ id: sale, title: 'Sale', type: 'http', url: '/collections/sale', items: [] }],
      },
    ];
    await admin.query(
      `INSERT INTO online_store.menus (shop_id, id, handle, title, items)
       VALUES ($1, $2, 'shop-by', 'Shop by', $3)`,
      [shop, menu, JSON.stringify(items)],
    );
    // The shop's own words for its home page are by its own ID.
    for (const [id, key] of [
      [page, 'title'],
      [menu, 'title'],
      [home, 'title'],
      [sale, 'title'],
      [product, 'title'],
      [dropped, 'title'],
      [shop, 'meta_title'],
    ]) {
      await admin.query(
        `INSERT INTO online_store.translations (shop_id, resource_id, locale, key, value, digest)
         VALUES ($1, $2, 'ur', $3, 'ترجمہ', $4)`,
        [shop, id, key, 'a'.repeat(64)],
      );
    }

    const result = await migrateThrough(db.adminUrl, '0164');
    expect(result.applied[0]).toBe('0164_translations_forgotten');

    const kept = async () =>
      (
        await admin!.query<{ id: string }>(
          `SELECT resource_id AS id FROM online_store.translations`,
        )
      ).rows
        .map((row) => row.id)
        .sort();
    expect(await kept()).toEqual([page, menu, home, sale, shop].sort());
    // From now on they go with what they translate.
    await admin.query(`UPDATE online_store.menus SET items = '[]'`);
    await admin.query(`DELETE FROM online_store.pages`);
    expect(await kept()).toEqual([menu, shop].sort());
  });
});
