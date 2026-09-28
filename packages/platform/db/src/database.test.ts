import { createHash } from 'node:crypto';
import { newId, uuidVersion } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Database,
  LOGIN_DEFAULTS,
  TenantScopeError,
  createDb,
  createPool,
  isForeignKeyViolation,
  isUniqueViolation,
  migrate,
  pgError,
  toDate,
  toDateOrNull,
} from './index.js';
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

describe.skipIf(!server)('database foundation', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let db: Database;
  const shopA = newId();
  const shopB = newId();
  const productA = newId();
  const productB = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'db-test',
    });
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    await admin.query(
      `INSERT INTO catalog.products (shop_id, id, title, handle)
       VALUES ($1, $2, 'Lawn suit', 'lawn-suit'), ($3, $4, 'Khussa', 'khussa')`,
      [shopA, productA, shopB, productB],
    );
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  describe('migrations', () => {
    it('are idempotent', async () => {
      const result = await migrate({ connectionString: testDb.adminUrl });
      expect(result.applied).toEqual([]);
      expect(result.skipped).toBeGreaterThan(0);
    });

    it('refuse to run when an applied migration was edited', async () => {
      const version = '0001_foundation';
      const { rows } = await admin.query<{ checksum: string }>(
        'SELECT checksum FROM platform.schema_migrations WHERE version = $1',
        [version],
      );
      const original = rows[0]!.checksum;
      const setChecksum = (checksum: string) =>
        admin.query('UPDATE platform.schema_migrations SET checksum = $2 WHERE version = $1', [
          version,
          checksum,
        ]);
      await setChecksum('tampered');
      try {
        await expect(migrate({ connectionString: testDb.adminUrl })).rejects.toThrow(
          /changed after it was applied/,
        );
      } finally {
        await setChecksum(original);
      }
    });

    it('generate version 7 UUIDs in SQL', async () => {
      const { rows } = await admin.query<{ id: string }>('SELECT platform.uuidv7() AS id');
      expect(uuidVersion(rows[0]!.id)).toBe(7);
    });
  });

  describe('row-level security', () => {
    it('shows a shop only its own rows', async () => {
      const rows = await db.tenant(shopA, (tx) =>
        tx.execute<{ id: string }>(sql`select id from catalog.products`),
      );
      expect(rows.rows.map((row) => row.id)).toEqual([productA]);
    });

    it('shows nothing when no shop is set', async () => {
      const result = await db.app.execute(sql`select id from catalog.products`);
      expect(result.rows).toEqual([]);
    });

    it('does not leak the shop to the next transaction on the same connection', async () => {
      const pool = createPool({ connectionString: testDb.appUrl, applicationName: 'leak', max: 1 });
      const single = createDb(pool);
      try {
        await single.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.shop_id', ${shopA}, true)`);
        });
        const after = await single.execute(sql`select id from catalog.products`);
        expect(after.rows).toEqual([]);
      } finally {
        await pool.end();
      }
    });

    it("rejects writes into another shop's rows", async () => {
      const code = await errorCode(
        db.tenant(shopA, (tx) =>
          tx.execute(
            sql`insert into catalog.products (shop_id, title, handle) values (${shopB}, 'Sneaky', 'sneaky')`,
          ),
        ),
      );
      expect(code).toBe('42501');
    });

    it("cannot update or delete another shop's rows", async () => {
      const updated = await db.tenant(shopA, (tx) =>
        tx.execute(sql`update catalog.products set title = 'Hacked' where id = ${productB}`),
      );
      const deleted = await db.tenant(shopA, (tx) =>
        tx.execute(sql`delete from catalog.products where id = ${productB}`),
      );
      expect(updated.rowCount).toBe(0);
      expect(deleted.rowCount).toBe(0);
      const { rows } = await admin.query('SELECT title FROM catalog.products WHERE id = $1', [
        productB,
      ]);
      expect(rows[0]?.title).toBe('Khussa');
    });

    it('returns raw timestamps as text, which toDate() reads', async () => {
      const { rows } = await db.tenant(shopA, (tx) =>
        tx.execute<{ at: unknown; local: unknown }>(
          sql`select '2026-09-28 09:42:15.75563+00'::timestamptz as at,
                     '2026-09-28 14:42:15+05'::timestamptz as local`,
        ),
      );
      expect(typeof rows[0]!.at).toBe('string');
      expect(toDate(rows[0]!.at as string).toISOString()).toBe('2026-09-28T09:42:15.755Z');
      expect(toDate(rows[0]!.local as string).toISOString()).toBe('2026-09-28T09:42:15.000Z');
      expect(toDateOrNull(null)).toBeNull();
      expect(() => toDate('not a date')).toThrow(RangeError);
    });

    it('names the constraint a write broke, through the wrapping driver error', async () => {
      const duplicate = await db
        .tenant(shopA, (tx) =>
          tx.execute(
            sql`insert into catalog.products (shop_id, title, handle) values (${shopA}, 'Copy', 'lawn-suit')`,
          ),
        )
        .catch((error: unknown) => error);
      expect(pgError(duplicate)).toEqual({ code: '23505', constraint: 'products_shop_handle_key' });
      expect(isUniqueViolation(duplicate)).toBe(true);
      expect(isUniqueViolation(duplicate, 'products_shop_handle_key')).toBe(true);
      expect(isUniqueViolation(duplicate, 'another_key')).toBe(false);
      expect(isForeignKeyViolation(duplicate)).toBe(false);
      // Network errors carry a code too, but are not database errors.
      expect(pgError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBeUndefined();
      expect(pgError('not an error')).toBeUndefined();
    });

    it("cannot attach a variant to another shop's product", async () => {
      const code = await errorCode(
        db.tenant(shopA, (tx) =>
          tx.execute(
            sql`insert into catalog.variants (shop_id, product_id, price) values (${shopA}, ${productB}, 100)`,
          ),
        ),
      );
      expect(code).toBe('23503');
    });

    it('lets a shop read its own shop record only, and not create shops', async () => {
      const shops = await db.tenant(shopA, (tx) =>
        tx.execute<{ id: string }>(sql`select id from control.shops`),
      );
      expect(shops.rows.map((row) => row.id)).toEqual([shopA]);
      const code = await errorCode(
        db.tenant(shopA, (tx) => tx.execute(sql`insert into control.shops (name) values ('New')`)),
      );
      expect(code).toBe('42501');
    });

    it('lets request code append to the outbox for its own shop but not read it', async () => {
      await db.tenant(shopA, (tx) =>
        tx.execute(sql`
          insert into platform.outbox_events (id, shop_id, aggregate_type, aggregate_id, event_type, payload)
          values (${newId()}, ${shopA}, 'product', ${productA}, 'product.updated', '{}')`),
      );
      const foreign = await errorCode(
        db.tenant(shopA, (tx) =>
          tx.execute(sql`
            insert into platform.outbox_events (id, shop_id, aggregate_type, aggregate_id, event_type, payload)
            values (${newId()}, ${shopB}, 'product', ${productB}, 'product.updated', '{}')`),
        ),
      );
      expect(foreign).toBe('42501');
      const read = await errorCode(
        db.tenant(shopA, (tx) => tx.execute(sql`select * from platform.outbox_events`)),
      );
      expect(read).toBe('42501');
    });

    it('gives the system role every shop', async () => {
      const result = await db.system((tx) =>
        tx.execute<{ shop_id: string }>(sql`select shop_id from catalog.products order by title`),
      );
      expect(result.rows.map((row) => row.shop_id)).toEqual([shopB, shopA]);
    });

    it('rejects an invalid shop id before touching the database', async () => {
      await expect(db.tenant('not-a-uuid', async () => 1)).rejects.toBeInstanceOf(TenantScopeError);
    });
  });

  describe('connections, limits and pooling', () => {
    // These run through PgBouncer in transaction mode when DATABASE_POOLER_URL is set, as in CI.

    it('gives every login its session defaults, however it connects', async () => {
      for (const url of [testDb.appUrl, testDb.systemUrl, testDb.identityUrl]) {
        const pool = createPool({ connectionString: url, applicationName: 'defaults', max: 1 });
        try {
          const { rows } = await pool.query(
            `select current_setting('statement_timeout') as statement,
                    current_setting('idle_in_transaction_session_timeout') as idle`,
          );
          expect(rows[0]).toEqual({
            statement: LOGIN_DEFAULTS.statement_timeout,
            idle: LOGIN_DEFAULTS.idle_in_transaction_session_timeout,
          });
        } finally {
          await pool.end();
        }
      }
    });

    it('cancels a statement that runs past the tenant transaction limit, for that transaction only', async () => {
      const limited = new Database({
        appUrl: testDb.appUrl,
        applicationName: 'limits',
        maxConnections: 1,
        transactionLimits: { statementTimeoutMs: 100 },
      });
      try {
        const code = await errorCode(
          limited.tenant(shopA, (tx) => tx.execute(sql`select pg_sleep(2)`)),
        );
        expect(code).toBe('57014');
        const { rows } = await limited.app.execute<{ timeout: string }>(
          sql`select current_setting('statement_timeout') as timeout`,
        );
        expect(rows[0]?.timeout).toBe(LOGIN_DEFAULTS.statement_timeout);
      } finally {
        await limited.close();
      }
    });

    it('keeps shops apart across many interleaved transactions on a few connections', async () => {
      const shared = new Database({
        appUrl: testDb.appUrl,
        applicationName: 'interleave',
        maxConnections: 4,
      });
      const problems: string[] = [];
      try {
        await Promise.all(
          Array.from({ length: 16 }, async (_, caller) => {
            for (let round = 0; round < 25; round++) {
              const shop = (caller + round) % 2 === 0 ? shopA : shopB;
              try {
                await shared.tenant(shop, async (tx) => {
                  const { rows } = await tx.execute<{ current: string; foreign: string }>(sql`
                    select platform.current_shop_id() as current,
                           (select count(*) from catalog.products where shop_id <> ${shop}) as foreign`);
                  if (rows[0]?.current !== shop) problems.push(`shop ${rows[0]?.current}`);
                  if (Number(rows[0]?.foreign) !== 0) problems.push('saw another shop');
                  // Some transactions fail, which ends them differently.
                  if (round % 5 === 0) await tx.execute(sql`select 1 / 0`);
                });
              } catch (error) {
                if ((await errorCode(Promise.reject(error))) !== '22012') throw error;
              }
              const outside = await shared.app.execute<{ shop: string | null }>(
                sql`select current_setting('app.shop_id', true) as shop`,
              );
              if (outside.rows[0]?.shop) problems.push(`outside: ${outside.rows[0].shop}`);
            }
          }),
        );
      } finally {
        await shared.close();
      }
      expect(problems).toEqual([]);
    });
  });

  describe('access token resolution', () => {
    const hash = (secret: string) => createHash('sha256').update(secret).digest();

    beforeAll(async () => {
      const insert = `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes, expires_at, revoked_at)
                      VALUES ($1, $2, $3, 'xxxx', $4, $5, $6)`;
      await admin.query(insert, [shopA, 'valid', hash('valid'), ['read_products'], null, null]);
      await admin.query(insert, [shopA, 'revoked', hash('revoked'), [], null, new Date()]);
      await admin.query(insert, [shopA, 'expired', hash('expired'), [], new Date(0), null]);
      await admin.query(insert, [shopB, 'suspended', hash('suspended'), [], null, null]);
      await admin.query(`UPDATE control.shops SET status = 'suspended' WHERE id = $1`, [shopB]);
    });

    afterAll(async () => {
      await admin.query(`UPDATE control.shops SET status = 'active' WHERE id = $1`, [shopB]);
    });

    const resolve = (secret: string) =>
      db.app.execute<{ shop_id: string; scopes: string[]; shop_currency: string }>(
        sql`select * from platform.resolve_access_token(${hash(secret)})`,
      );

    it('resolves a valid token to its shop and scopes without a shop context', async () => {
      const { rows } = await resolve('valid');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        shop_id: shopA,
        scopes: ['read_products'],
        shop_currency: 'PKR',
      });
    });

    it.each(['revoked', 'expired', 'suspended', 'unknown'])(
      'rejects a %s token',
      async (secret) => {
        const { rows } = await resolve(secret);
        expect(rows).toEqual([]);
      },
    );

    it('does not expose the token table to request code', async () => {
      const result = await db.app.execute(sql`select * from apps.access_tokens`);
      expect(result.rows).toEqual([]);
    });
  });
});
