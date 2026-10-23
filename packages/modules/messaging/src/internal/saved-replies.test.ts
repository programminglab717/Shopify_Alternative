import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAVED_REPLY_LIMITS, SavedRepliesService } from './saved-replies.js';

const server = testDatabaseServer();

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_conversations']),
  };
}

describe.skipIf(!server)("The inbox's saved replies (MSG-06, ADR-758)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let replies: SavedRepliesService;
  const a = tenant(newId());
  const b = tenant(newId());

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'saved-replies-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    replies = new SavedRepliesService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM messaging.saved_replies');
  });

  it('keeps replies by title, each title once whatever its case, changed and deleted, for its shop alone', async () => {
    const delivery = await replies.create(a, {
      title: '  Delivery charges ',
      body: 'Rs 200 across Pakistan, free above Rs 5,000.\nلاہور میں اگلے دن۔',
    });
    expect(delivery.ok && delivery.value).toMatchObject({
      title: 'Delivery charges',
      body: 'Rs 200 across Pakistan, free above Rs 5,000.\nلاہور میں اگلے دن۔',
    });
    await replies.create(a, { title: 'Bank details', body: 'Meezan Bank, IBAN PK36 MEZN 0001' });
    expect((await replies.list(a)).map((each) => each.title)).toEqual([
      'Bank details',
      'Delivery charges',
    ]);
    expect(await replies.list(b)).toEqual([]);

    expect(await replies.create(a, { title: 'delivery CHARGES', body: 'Again' })).toEqual({
      ok: false,
      errors: [
        {
          field: ['title'],
          code: 'TAKEN',
          message: 'A saved reply is called delivery CHARGES already',
        },
      ],
    });
    // Another shop's titles are its own.
    expect((await replies.create(b, { title: 'Delivery charges', body: 'Rs 250' })).ok).toBe(true);
    const blank = await replies.create(a, { title: ' ', body: 'x'.repeat(4097) });
    expect(!blank.ok && blank.errors.map((error) => [error.field, error.code])).toEqual([
      [['title'], 'BLANK'],
      [['body'], 'TOO_LONG'],
    ]);

    const id = delivery.ok ? delivery.value.id : '';
    const changed = await replies.update(a, id, {
      title: 'Delivery',
      body: 'Rs 250 across Pakistan.',
    });
    expect(changed.ok && changed.value.title).toBe('Delivery');
    // Its own title, in another case, is its own still.
    expect((await replies.update(a, id, { title: 'DELIVERY', body: 'Rs 250' })).ok).toBe(true);
    const other = (await replies.list(a)).find((each) => each.title === 'Bank details')!;
    expect(await replies.update(a, other.id, { title: 'delivery', body: 'x' })).toMatchObject({
      ok: false,
      errors: [{ code: 'TAKEN' }],
    });
    // Another shop's reply is not found.
    expect(await replies.update(b, id, { title: 'Mine', body: 'x' })).toMatchObject({
      ok: false,
      errors: [{ code: 'NOT_FOUND' }],
    });
    expect(await replies.delete(b, id)).toBe(false);
    expect(await replies.delete(a, id)).toBe(true);
    expect((await replies.list(a)).map((each) => each.title)).toEqual(['Bank details']);
  });

  it('keeps 100 replies a shop at most', async () => {
    await admin.query(
      `INSERT INTO messaging.saved_replies (shop_id, title, body)
       SELECT $1, 'Reply ' || n, 'Words' FROM generate_series(1, $2::int) AS n`,
      [a.shopId, SAVED_REPLY_LIMITS.replies],
    );
    expect(await replies.create(a, { title: 'One more', body: 'Words' })).toEqual({
      ok: false,
      errors: [
        { field: ['title'], code: 'TOO_MANY', message: 'A shop keeps 100 saved replies at most' },
      ],
    });
  });
});
