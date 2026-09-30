import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { Database, migrate, pgError } from './index.js';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from './testing/index.js';

const server = testDatabaseServer();

/** Postgres error code of a rejected promise; drizzle wraps driver errors in `cause`. */
async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgError(error)?.code;
  }
  return undefined;
}

describe.skipIf(!server)('shop handles (migration 0021)', () => {
  let testDb: TestDatabase | undefined;
  let admin: pg.Client | undefined;
  let db: Database | undefined;

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('gives shops made before handles one each, then checks every handle', async () => {
    testDb = await createTestDatabase(server, { before: '0021' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    const [old, older] = [newId(), newId()];
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Old'), ($2, 'Older')`, [
      old,
      older,
    ]);
    const result = await migrate({ connectionString: testDb.adminUrl });
    expect(result.applied[0]).toBe('0021_shop_handles');

    const { rows } = await admin.query<{ handle: string }>('SELECT handle FROM control.shops');
    expect(rows).toHaveLength(2);
    for (const { handle } of rows) expect(handle).toMatch(/^shop-[0-9a-f]{12}$/);
    expect(rows[0]!.handle).not.toBe(rows[1]!.handle);

    const shop = (handle: string) =>
      errorCode(
        admin!.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'New', $2)`, [
          newId(),
          handle,
        ]),
      );
    expect(await shop('zari-fashions')).toBeUndefined();
    expect(await shop('zari-fashions')).toBe('23505');
    for (const bad of ['Zari', 'zari.pk', '-zari', 'zari-', 'xn--zari', 'z'.repeat(41), '']) {
      expect(await shop(bad), bad).toBe('23514');
    }
    expect(await shop('z')).toBeUndefined();
    expect(await shop('z'.repeat(40))).toBeUndefined();
  });

  it('lets a shop rename itself, but not change its handle or status', async () => {
    const shopId = newId();
    await admin!.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari-own')`,
      [shopId],
    );
    db = new Database({ appUrl: testDb!.appUrl, applicationName: 'shop-handles-test' });
    await db.tenant(shopId, (tx) =>
      tx.execute(sql`UPDATE control.shops SET name = 'Zari Fashions' WHERE id = ${shopId}`),
    );
    for (const change of [sql`handle = 'stolen'`, sql`status = 'active'`]) {
      const code = await errorCode(
        db.tenant(shopId, (tx) =>
          tx.execute(sql`UPDATE control.shops SET ${change} WHERE id = ${shopId}`),
        ),
      );
      expect(code).toBe('42501');
    }
    const { rows } = await admin!.query('SELECT name, handle FROM control.shops WHERE id = $1', [
      shopId,
    ]);
    expect(rows[0]).toEqual({ name: 'Zari Fashions', handle: 'zari-own' });
  });
});
