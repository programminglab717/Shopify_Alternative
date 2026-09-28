import { Database, pgError } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAudit, recordAudit, type NewAuditEntry } from './index.js';

const server = testDatabaseServer();

describe.skipIf(!server)('audit log', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  const [shopA, shopB] = [newId(), newId()];
  const [ayesha, order] = [newId(), newId()];
  const agent = newId();

  const entry = (overrides: Partial<NewAuditEntry> = {}): NewAuditEntry => ({
    action: 'customer.phone_revealed',
    subjectType: 'customer',
    subjectId: ayesha,
    actorKind: 'staff',
    actorId: agent,
    actorRole: 'confirmation_agent',
    ...overrides,
  });

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'audit-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('records entries with the change they describe, and lists them newest first', async () => {
    await db.tenant(shopA, (tx) => recordAudit(tx, shopA, entry()));
    await expect(
      db.tenant(shopA, async (tx) => {
        await recordAudit(tx, shopA, entry({ action: 'customer.erased' }));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await db.tenant(shopA, (tx) =>
      recordAudit(
        tx,
        shopA,
        entry({
          action: 'order.phone_revealed',
          subjectType: 'order',
          subjectId: order,
          details: { number: 1001 },
        }),
      ),
    );
    await db.tenant(shopB, (tx) => recordAudit(tx, shopB, entry()));

    const all = await db.tenant(shopA, (tx) => listAudit(tx, shopA, { first: 10 }));
    expect(all.items.map((item) => [item.action, item.subjectId, item.details])).toEqual([
      ['order.phone_revealed', order, { number: 1001 }],
      ['customer.phone_revealed', ayesha, {}],
    ]);
    expect(all.items[0]).toMatchObject({
      actorKind: 'staff',
      actorId: agent,
      actorRole: 'confirmation_agent',
    });
    expect(all.items[0]!.occurredAt).toBeInstanceOf(Date);

    const page = await db.tenant(shopA, (tx) => listAudit(tx, shopA, { first: 1 }));
    expect(page.hasNextPage).toBe(true);
    const next = await db.tenant(shopA, (tx) =>
      listAudit(tx, shopA, { first: 1, after: page.items[0]!.id }),
    );
    expect(next.items.map((item) => item.subjectId)).toEqual([ayesha]);
    const bySubject = await db.tenant(shopA, (tx) =>
      listAudit(tx, shopA, { first: 10, subjectId: order }),
    );
    expect(bySubject.items).toHaveLength(1);
    const byAction = await db.tenant(shopA, (tx) =>
      listAudit(tx, shopA, { first: 10, action: 'customer.phone_revealed' }),
    );
    expect(byAction.items.map((item) => item.subjectId)).toEqual([ayesha]);
  });

  it('is append-only for request code, and each shop sees its own', async () => {
    for (const statement of [
      sql`UPDATE platform.audit_log SET action = 'customer.exported'`,
      sql`DELETE FROM platform.audit_log`,
    ]) {
      const error = await db
        .tenant(shopA, (tx) => tx.execute(statement))
        .catch((caught: unknown) => caught);
      expect(pgError(error)?.code).toBe('42501');
    }
    const other = await db.tenant(shopB, (tx) =>
      tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM platform.audit_log`),
    );
    const { rows } = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM platform.audit_log WHERE shop_id = $1',
      [shopB],
    );
    expect(other.rows[0]!.count).toBe(rows[0]!.count);
  });
});
