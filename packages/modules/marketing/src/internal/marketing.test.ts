import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversionsService } from './conversions.service.js';
import { MetaConversionsService } from './meta-settings.service.js';
import { conversions, metaSettings } from './schema.js';

const server = testDatabaseServer();

const TOKEN = 'EAAGm0PX4ZCpsBAKs3bZBqmlLZAZ'.padEnd(60, 'q') + 'Wx9z';

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_pixels']),
  };
}

describe.skipIf(!server)("Meta's conversions API: the shop's dataset and its moments", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let meta: MetaConversionsService;
  let moments: ConversionsService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  const b = tenant(newId());

  const outbox = async () =>
    (
      await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
        'SELECT event_type, payload FROM platform.outbox_events ORDER BY id',
      )
    ).rows.map((row) => [row.event_type, row.payload.changed ?? row.payload.pixelId]);

  const statuses = async (shopId = a.shopId) =>
    (
      await admin.query<{ order_id: string; moment: string; status: string; attempts: number }>(
        `SELECT order_id, moment, status, attempts FROM marketing.conversions
          WHERE shop_id = $1 ORDER BY occurred_at, moment`,
        [shopId],
      )
    ).rows.map((row) => [row.order_id, row.moment, row.status, row.attempts]);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'marketing-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    meta = new MetaConversionsService(db, box);
    moments = new ConversionsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM marketing.meta_settings; DELETE FROM marketing.conversions; ' +
        'DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log',
    );
  });

  it('matches the migrated tables', async () => {
    await db.tenant(a.shopId, (tx) => tx.select().from(metaSettings).limit(1));
    await db.tenant(a.shopId, (tx) => tx.select().from(conversions).limit(1));
  });

  it('connects with the pixel and a token, keeping the token sealed and showing its end', async () => {
    expect(await meta.get(a)).toBeNull();
    const refused = await meta.update(a, { pixelId: '1234567890' });
    expect(refused.ok || refused.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.accessToken', 'BLANK'],
    ]);
    const wrong = await meta.update(a, {
      pixelId: 'pixel-1',
      accessToken: 'short',
      testEventCode: 'TEST 1',
    });
    expect(wrong.ok || wrong.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.pixelId', 'INVALID'],
      ['input.accessToken', 'INVALID'],
      ['input.testEventCode', 'INVALID'],
    ]);

    const connected = unwrap(
      await meta.update(a, { pixelId: ' 1234 5678 90 ', accessToken: ` ${TOKEN} ` }),
    );
    expect(connected).toMatchObject({
      pixelId: '1234567890',
      tokenHint: 'Wx9z',
      testEventCode: null,
      purchaseAt: 'placed',
    });
    // Kept sealed, for the shop alone; the worker opens it to send.
    const { rows } = await admin.query<{ access_token: string }>(
      'SELECT access_token FROM marketing.meta_settings',
    );
    expect(rows[0]!.access_token).not.toContain(TOKEN.slice(0, 20));
    expect(await meta.datasetOf(a.shopId)).toEqual({
      pixelId: '1234567890',
      accessToken: TOKEN,
      testEventCode: null,
      purchaseAt: 'placed',
    });
    expect(await meta.datasetOf(b.shopId)).toBeNull();
    expect(await meta.get(b)).toBeNull();

    // The same token again changes nothing; a test code and a later Purchase change what they say.
    unwrap(await meta.update(a, { accessToken: TOKEN, pixelId: '1234567890' }));
    expect(
      unwrap(await meta.update(a, { testEventCode: ' TEST4242 ', purchaseAt: 'delivered' })),
    ).toMatchObject({ testEventCode: 'TEST4242', purchaseAt: 'delivered', tokenHint: 'Wx9z' });
    expect(unwrap(await meta.update(a, { testEventCode: '' })).testEventCode).toBeNull();
    expect(await outbox()).toEqual([
      ['meta_conversions.updated', ['pixelId', 'accessToken']],
      ['meta_conversions.updated', ['testEventCode', 'purchaseAt']],
      ['meta_conversions.updated', ['testEventCode']],
    ]);
    // Audited, the token never.
    const { rows: audit } = await admin.query<{ action: string; details: string }>(
      'SELECT action, details::text FROM platform.audit_log ORDER BY id',
    );
    expect(audit.map((row) => row.action)).toEqual([
      'meta_conversions.updated',
      'meta_conversions.updated',
      'meta_conversions.updated',
    ]);
    expect(audit.some((row) => row.details.includes(TOKEN.slice(0, 20)))).toBe(false);
    expect(JSON.parse(audit[1]!.details)).toMatchObject({
      purchaseAt: 'delivered',
      before: { purchaseAt: 'placed', testEventCode: null, tokenHint: 'Wx9z' },
    });
  });

  it("records an order's moments once each, and its later ones only after its placing", async () => {
    const [placed, before] = [newId(), newId()];
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 9, minute));

    // Not connected: nothing; an order placed before connecting has nothing after either.
    expect(await moments.recordPlaced(a.shopId, before, at(0))).toBe(0);
    unwrap(await meta.update(a, { pixelId: '1234567890', accessToken: TOKEN }));
    expect(await moments.recordAfterPlaced(a.shopId, before, 'delivered', at(1))).toBe(0);

    expect(await moments.recordPlaced(a.shopId, placed, at(2))).toBe(1);
    expect(await moments.recordPlaced(a.shopId, placed, at(3))).toBe(0);
    expect(await moments.placedRecorded(a.shopId, placed)).toBe(true);
    expect(await moments.placedRecorded(a.shopId, before)).toBe(false);
    expect(await moments.recordAfterPlaced(a.shopId, placed, 'confirmed', at(4))).toBe(1);
    expect(await moments.recordAfterPlaced(a.shopId, placed, 'confirmed', at(5))).toBe(0);
    expect(await moments.recordAfterPlaced(a.shopId, placed, 'delivered', at(6))).toBe(1);
    expect(await statuses()).toEqual([
      [placed, 'placed', 'pending', 0],
      [placed, 'confirmed', 'pending', 0],
      [placed, 'delivered', 'pending', 0],
    ]);
    // Another shop sees none of them.
    expect((await moments.list(b, { first: 10, after: null })).items).toEqual([]);
  });

  it('hands moments due to one sender at a time, and settles them as sending went', async () => {
    unwrap(await meta.update(a, { pixelId: '1234567890', accessToken: TOKEN }));
    unwrap(await meta.update(b, { pixelId: '9876543210', accessToken: TOKEN }));
    const orders = [newId(), newId(), newId()];
    const t0 = new Date('2026-10-02T09:00:00.000Z');
    for (const [index, order] of orders.entries()) {
      await moments.recordPlaced(a.shopId, order, new Date(t0.getTime() + index * 1_000));
    }
    await moments.recordPlaced(b.shopId, newId(), t0);
    const now = new Date();

    expect((await moments.dueShops(now)).sort()).toEqual([a.shopId, b.shopId].sort());
    const claimed = await moments.claim(a.shopId, now, 2, 300_000);
    expect(claimed.map((each) => [each.orderId, each.moment, each.attempts])).toEqual([
      [orders[0], 'placed', 1],
      [orders[1], 'placed', 1],
    ]);
    // Taken: the next sender gets the rest, and none once they are all out.
    expect((await moments.claim(a.shopId, now, 10, 300_000)).map((each) => each.orderId)).toEqual([
      orders[2],
    ]);
    expect(await moments.claim(a.shopId, now, 10, 300_000)).toEqual([]);

    const later = new Date(now.getTime() + 60_000);
    await moments.settle(
      a.shopId,
      [
        { id: claimed[0]!.id, status: 'sent', eventName: 'Purchase', traceId: 'AbC' },
        {
          id: claimed[1]!.id,
          status: 'pending',
          error: 'Error validating access token',
          traceId: 'T1',
          nextAttemptAt: later,
        },
      ],
      now,
    );
    const { items } = await moments.list(a, { first: 10, after: null });
    expect(
      items.map((each) => [each.orderId, each.status, each.eventName, each.error, each.traceId]),
    ).toEqual([
      [orders[2], 'pending', null, null, null],
      [orders[1], 'pending', null, 'Error validating access token', 'T1'],
      [orders[0], 'sent', 'Purchase', null, 'AbC'],
    ]);
    expect(items[2]!.sentAt).toEqual(now);
    // Due again when it said; one sent stays sent, whatever comes after.
    expect(await moments.claim(a.shopId, now, 10, 300_000)).toEqual([]);
    expect((await moments.claim(a.shopId, later, 10, 300_000)).map((each) => each.id)).toEqual([
      claimed[1]!.id,
    ]);
    await moments.settle(
      a.shopId,
      [
        { id: claimed[0]!.id, status: 'failed', eventName: 'Purchase', error: 'No', traceId: null },
        { id: claimed[1]!.id, status: 'expired', error: 'Not sent: too old' },
      ],
      later,
    );
    expect(await statuses()).toEqual([
      [orders[0], 'placed', 'sent', 1],
      [orders[1], 'placed', 'expired', 2],
      [orders[2], 'placed', 'pending', 1],
    ]);
  });

  it('lists the latest first a page at a time, by status or order, and skips what waits once disconnected', async () => {
    unwrap(await meta.update(a, { pixelId: '1234567890', accessToken: TOKEN }));
    const orders = Array.from({ length: 5 }, () => newId());
    for (const order of orders) await moments.recordPlaced(a.shopId, order, new Date());
    await moments.recordAfterPlaced(a.shopId, orders[0]!, 'confirmed', new Date());

    const first = await moments.list(a, { first: 4, after: null });
    expect(first.hasNextPage).toBe(true);
    const last = first.items.at(-1)!;
    const rest = await moments.list(a, {
      first: 4,
      after: { id: last.id, createdAt: last.createdAtExactly },
    });
    expect(rest.hasNextPage).toBe(false);
    expect([...first.items, ...rest.items].map((each) => each.id)).toHaveLength(6);
    expect(
      (await moments.list(a, { first: 10, after: null, orderId: orders[0] })).items.map(
        (each) => each.moment,
      ),
    ).toEqual(['confirmed', 'placed']);

    // Disconnected: the token is forgotten, and what waited is not sent.
    expect(await meta.delete(a)).toBe('1234567890');
    expect(await meta.delete(a)).toBeNull();
    expect(await meta.get(a)).toBeNull();
    const skipped = await moments.list(a, { first: 10, after: null, status: 'skipped' });
    expect(skipped.items).toHaveLength(6);
    expect(skipped.items[0]!.error).toBe('Not sent: the shop disconnected Meta');
    expect((await outbox()).at(-1)).toEqual(['meta_conversions.deleted', '1234567890']);
  });
});
