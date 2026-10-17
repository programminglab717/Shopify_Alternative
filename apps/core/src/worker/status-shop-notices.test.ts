import 'reflect-metadata';
import { PublicSite, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { MessagesService, MessagingSettingsService } from '@hatti/messaging/public';
import { IncidentsService, StatusSubscriptionsService } from '@hatti/trust/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusShopNotices } from './status-shop-notices.js';

const server = testDatabaseServer();
const AT = new Date('2026-10-17T09:00:00Z');
const minutes = (count: number) => new Date(AT.getTime() + count * 60_000);

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_settings']),
  };
}

describe.skipIf(!server)("Shops told of Hatti's outages on WhatsApp (BIL-06, ADR-544)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let incidents: IncidentsService;
  const [a, b, c] = [tenant(newId()), tenant(newId()), tenant(newId())];

  /** The notices queued, oldest first: their shop, number, key and words. */
  const told = async () =>
    (
      await admin.query<{
        shop_id: string;
        recipient: string;
        dedupe_key: string;
        variables: Record<string, string>;
      }>(
        `SELECT shop_id, recipient, dedupe_key, variables FROM messaging.messages
          WHERE kind = 'status_update' ORDER BY created_at, id`,
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'status-shop-notices-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Zari Fashions'), ($2, 'Noor'), ($3, 'C')`,
      [a.shopId, b.shopId, c.shopId],
    );
    const settings = new MessagingSettingsService(database);
    unwrap(await settings.update(a, { alertsPhone: '0300 1112223' }));
    unwrap(await settings.update(b, { alertsPhone: '0300 4445556', language: 'ur' }));
    // C gives no number: nothing for it.
    incidents = new IncidentsService(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('tells every shop with a number when an outage begins and ends, in its language, each once', async () => {
    const queued: unknown[] = [];
    const messages = new MessagesService(database);
    const notices = new StatusShopNotices(
      new StatusSubscriptionsService(database),
      database,
      {
        queueIn: (tx, shopId, message) => {
          queued.push(shopId);
          return messages.queueIn(tx, shopId, message);
        },
      },
      new PublicSite('https://hatti.pk'),
    );
    expect(await notices.sweep(AT)).toBe(0);

    const opened = await incidents.open(
      {
        kind: 'incident',
        impact: 'outage',
        components: ['checkout', 'payments'],
        title: 'Checkout down',
        titleUr: 'چیک آؤٹ بند',
        body: 'Orders cannot be placed.',
        by: 'Hamza',
      },
      minutes(1),
    );
    if (!opened.ok) throw new Error(opened.problem);
    expect(await notices.sweep(minutes(2))).toBe(2);
    const first = await told();
    expect(first).toEqual([
      expect.objectContaining({
        shop_id: a.shopId,
        recipient: '+923001112223',
        variables: {
          shop: 'Zari Fashions',
          title: 'Checkout down',
          status: 'Investigating',
          touches: 'Checkout, Online payments',
          url: 'https://hatti.pk/status',
        },
      }),
      expect.objectContaining({
        shop_id: b.shopId,
        recipient: '+923004445556',
        // In Urdu, as Noor reads its messages.
        variables: {
          shop: 'Noor',
          title: 'چیک آؤٹ بند',
          status: 'جانچ جاری ہے',
          touches: 'چیک آؤٹ، آن لائن ادائیگیاں',
          url: 'https://hatti.pk/status',
        },
      }),
    ]);
    expect(first[0]!.dedupe_key).toMatch(/^status_update:/);
    // Sent once, however often the sweep runs.
    expect(await notices.sweep(minutes(3))).toBe(0);

    // What is said while it lasts goes to no shop; its ending does.
    await incidents.update(
      opened.value.id,
      { status: 'identified', body: 'Found it.', by: 'Hamza' },
      minutes(10),
    );
    expect(await notices.sweep(minutes(11))).toBe(0);
    await incidents.update(
      opened.value.id,
      { status: 'resolved', body: 'Back.', by: 'Hamza' },
      minutes(20),
    );
    expect(await notices.sweep(minutes(21))).toBe(2);
    expect((await told()).slice(2).map((row) => row.variables.status)).toEqual([
      'Resolved',
      'حل ہو گیا',
    ]);
    expect(queued).toHaveLength(4);
  });

  it('tries a shop that failed again next sweep, the others not twice', async () => {
    const before = (await told()).length;
    const messages = new MessagesService(database);
    let failing = true;
    const notices = new StatusShopNotices(
      new StatusSubscriptionsService(database),
      database,
      {
        queueIn: (tx, shopId, message) => {
          if (failing && shopId === b.shopId) throw new Error('down');
          return messages.queueIn(tx, shopId, message);
        },
      },
      new PublicSite('https://hatti.pk'),
      { warn: () => undefined },
    );
    const opened = await incidents.open(
      {
        kind: 'incident',
        impact: 'outage',
        components: ['admin'],
        title: 'Admin down',
        body: 'The admin does not open.',
        by: 'Hamza',
      },
      minutes(100),
    );
    if (!opened.ok) throw new Error(opened.problem);
    expect(await notices.sweep(minutes(101))).toBe(1);
    failing = false;
    // A's is queued again but kept once; B's goes now.
    await notices.sweep(minutes(102));
    const after = (await told()).slice(before);
    expect(after.map((row) => row.shop_id)).toEqual([a.shopId, b.shopId]);
    expect(await notices.sweep(minutes(103))).toBe(0);
  });
});
