import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGING_CUSTOMER_DATA } from './customer-data.js';
import { MessagesService } from './messages.service.js';
import { STOCK_WATCHES_PER_PHONE, StockWatchService } from './stock-watches.service.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Back in stock: shoppers waiting for a variant (MKT-04, ADR-429)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let watches: StockWatchService;
  const shopId = newId();
  const productId = newId();
  const lawn = newId();
  const kurta = newId();

  const turn = (enabled: boolean) =>
    admin.query(
      `INSERT INTO messaging.automations (shop_id, kind, enabled) VALUES ($1, 'back_in_stock', $2)
       ON CONFLICT (shop_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [shopId, enabled],
    );

  const told = async () =>
    (
      await admin.query<{ recipient: string; language: string; variables: Record<string, string> }>(
        `SELECT recipient, language, variables FROM messaging.messages
          WHERE shop_id = $1 AND kind = 'back_in_stock' ORDER BY created_at, recipient`,
        [shopId],
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'stock-watches-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopId]);
    watches = new StockWatchService(db, new MessagesService(db));
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('keeps a wish only while the automation is on, once a number and variant', async () => {
    const wish = { variantId: lawn, productId, phone: '0300 1234567', language: 'en' as const };
    expect(await watches.watch(shopId, wish)).toEqual({
      ok: false,
      errors: [{ field: 'base', message: "This shop doesn't send back in stock messages" }],
    });
    await turn(true);
    expect(await watches.watch(shopId, { ...wish, phone: '12345' })).toEqual({
      ok: false,
      errors: [{ field: 'phone', message: 'Enter a Pakistani mobile number' }],
    });
    expect(await watches.watch(shopId, wish)).toEqual({ ok: true, created: true });
    // Asked again, as typed another way: the first is kept.
    expect(await watches.watch(shopId, { ...wish, phone: '+923001234567' })).toEqual({
      ok: true,
      created: false,
    });
    expect(await watches.watch(shopId, { ...wish, phone: '0321 7654321', language: 'ur' })).toEqual(
      { ok: true, created: true },
    );

    // One number waits for so many variants at most.
    for (let index = 1; index < STOCK_WATCHES_PER_PHONE; index++) {
      await watches.watch(shopId, { ...wish, variantId: newId() });
    }
    expect(await watches.watch(shopId, { ...wish, variantId: kurta })).toEqual({
      ok: false,
      errors: [{ field: 'phone', message: 'This number is waiting for enough products' }],
    });
    await admin.query(
      `DELETE FROM messaging.stock_watches WHERE shop_id = $1 AND variant_id <> $2`,
      [shopId, lawn],
    );
  });

  it('tells each shopper waiting once, in their language, and lets them ask again', async () => {
    const waiting = await db.tenant(shopId, (tx) => watches.waitingIn(tx, shopId, lawn));
    expect(waiting.map((each) => [each.phone, each.language])).toEqual([
      ['+923001234567', 'en'],
      ['+923217654321', 'ur'],
    ]);
    const url = 'https://zari.hatti.test/products/lawn?variant=1';
    expect(
      await db.tenant(shopId, (tx) =>
        watches.notifyIn(tx, shopId, waiting, { product: 'Lawn 3-piece (M)', url }),
      ),
    ).toBe(2);
    expect(await told()).toEqual([
      {
        recipient: '+923001234567',
        language: 'en',
        variables: { shop: 'Zari', product: 'Lawn 3-piece (M)', url },
      },
      {
        recipient: '+923217654321',
        language: 'ur',
        variables: { shop: 'Zari', product: 'Lawn 3-piece (M)', url },
      },
    ]);
    // Told: nobody waits; asking again waits anew.
    expect(await db.tenant(shopId, (tx) => watches.waitingIn(tx, shopId, lawn))).toEqual([]);
    expect(
      await watches.watch(shopId, {
        variantId: lawn,
        productId,
        phone: '0300 1234567',
        language: 'en',
      }),
    ).toEqual({ ok: true, created: true });
    // A wish past its days is not told.
    await admin.query(
      `UPDATE messaging.stock_watches SET created_at = now() - interval '91 days'
        WHERE shop_id = $1 AND notified_at IS NULL`,
      [shopId],
    );
    expect(await db.tenant(shopId, (tx) => watches.waitingIn(tx, shopId, lawn))).toEqual([]);
  });

  it("goes with an erased customer's numbers, and is in their own file", async () => {
    const customer = {
      id: newId(),
      phones: ['+923001234567'],
      email: null,
    } as never;
    const file = await db.tenant(shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.export(tx, shopId, customer),
    );
    // The oldest first: the wish past its days, then the one told.
    expect((file as { backInStockRequests: unknown[] }).backInStockRequests).toEqual([
      expect.objectContaining({ variantId: lawn, number: '+923001234567', toldAt: null }),
      expect.objectContaining({
        variantId: lawn,
        number: '+923001234567',
        toldAt: expect.any(Date),
      }),
    ]);
    await db.tenant(shopId, (tx) => MESSAGING_CUSTOMER_DATA.erase(tx, shopId, customer, 'system'));
    const { rows } = await admin.query<{ phone: string }>(
      'SELECT phone FROM messaging.stock_watches WHERE shop_id = $1',
      [shopId],
    );
    expect(rows).toEqual([{ phone: '+923217654321' }]);
  });
});
