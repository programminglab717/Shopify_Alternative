import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGNAL_RULES, StoreSignalsService, nameKey, withinEdits } from './signals.service.js';

const server = testDatabaseServer();

describe('Names that read as another store’s (ADR-842)', () => {
  it('compares names by their letters, filler words left out, within an edit', () => {
    expect(nameKey('Khaadi Official Store PK')).toBe('khaadi');
    expect(nameKey('Gul-Ahmed  Pakistan')).toBe('gulahmed');
    expect(withinEdits('khaadi', 'khadi', 1)).toBe(true);
    expect(withinEdits('khaadi', 'kaadii', 1)).toBe(false);
    expect(withinEdits('sapphire', 'sapphire', 0)).toBe(true);
  });
});

describe.skipIf(!server)('Signs of a scam store (TNS-02, ADR-842)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let signals: StoreSignalsService;
  const at = new Date('2026-10-28T09:00:00Z');
  const daysAgo = (days: number) => new Date(at.getTime() - days * 86_400_000).toISOString();

  async function shop(name: string, createdDaysAgo: number, handle: string) {
    const id = newId();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, created_at) VALUES ($1, $2, $3, $4)`,
      [id, name, handle, daysAgo(createdDaysAgo)],
    );
    return id;
  }

  async function order(shopId: string, number: number, extra: Record<string, unknown>) {
    const row = {
      payment_method: 'bank_transfer',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      created_at: daysAgo(10),
      ...extra,
    };
    await admin.query(
      `INSERT INTO orders.orders
         (shop_id, id, number, source, confirmation_status, financial_status, stage,
          payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
          shipping_address, location_id, customer_id, fulfillment_status, created_at, phone)
       VALUES ($1, $2, $3, 'online_store', 'confirmed', $4, 'to_pack', $5, 'PKR', 500000, 0, 0, 500000,
               500000, 0, '{}', $6, $7, $8, $9, '+923001234567')`,
      [
        shopId,
        newId(),
        number,
        row.financial_status,
        row.payment_method,
        newId(),
        newId(),
        row.fulfillment_status,
        row.created_at,
      ],
    );
  }

  async function products(shopId: string, titles: string[], photo: (index: number) => number) {
    for (const [index, title] of titles.entries()) {
      const id = newId();
      await admin.query(
        `INSERT INTO catalog.products (shop_id, id, title, handle) VALUES ($1, $2, $3, $4)`,
        [shopId, id, title, `p-${index}`],
      );
      await admin.query(
        `INSERT INTO catalog.product_media
           (shop_id, id, product_id, source_url, position, width, height, image_size)
         VALUES ($1, $2, $3, 'https://example.com/x.jpg', 1, 1200, 1500, $4)`,
        [shopId, newId(), id, photo(index)],
      );
    }
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'signals-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    // Orders' customers and locations aren't what this is about.
    await admin.query(`SET session_replication_role = replica`);
    signals = new StoreSignalsService(db);
  });

  afterAll(async () => {
    await admin?.end();
    await db?.close();
    await testDb?.drop();
  });

  it('finds prepaid orders kept unshipped, copied catalogues and borrowed names, until cleared', async () => {
    // A young store sitting on five paid orders for days; another shipping its own.
    const keeper = await shop('Quick Deals', 20, 'quick-deals');
    for (let number = 1; number <= SIGNAL_RULES.unshippedOrders; number++) {
      await order(keeper, number, {});
    }
    await order(keeper, 99, { payment_method: 'cash_on_delivery', financial_status: 'pending' });
    const honest = await shop('Honest Lawn', 20, 'honest-lawn');
    for (let number = 1; number <= 6; number++) {
      await order(honest, number, { fulfillment_status: 'fulfilled' });
    }
    // An old store's paid orders waiting are not the sign: only young stores'.
    const old = await shop('Old Hands', 400, 'old-hands');
    for (let number = 1; number <= 6; number++) await order(old, number, {});

    // A verified brand, and a young store copying its catalogue and borrowing its name.
    const brand = await shop('Khaadi', 900, 'khaadi');
    await admin.query(
      `INSERT INTO trust.verifications
         (shop_id, id, level, name, status, decided_at, cnic_last4, asked_by)
       VALUES ($1, $2, 'identity', 'Khaadi Owner', 'approved', now(), '1234', $3)`,
      [brand, newId(), newId()],
    );
    const titles = Array.from({ length: 6 }, (_, index) => `Lawn suit ${index}`);
    await products(brand, titles, (index) => 400_000 + index);
    const copy = await shop('Khadi Official Store', 10, 'khadi-official');
    await products(copy, titles, (index) => 400_000 + index);
    // A young store of its own photos, whose titles happen to be common.
    const own = await shop('Nimra Studio', 10, 'nimra-studio');
    await products(
      own,
      ['Lawn suit 0', 'Kurta', 'Dupatta', 'Shalwar', 'Shawl', 'Scarf'],
      (i) => 7_000 + i,
    );

    expect(await signals.scan(at)).toBe(3);
    const standing = await signals.list();
    expect(standing.map((each) => [each.shopHandle, each.kind]).sort()).toEqual([
      ['khadi-official', 'cloned_catalogue'],
      ['khadi-official', 'impersonation'],
      ['quick-deals', 'prepaid_unshipped'],
    ]);
    expect(standing.find((each) => each.kind === 'prepaid_unshipped')?.detail).toMatchObject({
      orders: 5,
      total: '2500000',
    });
    expect(standing.find((each) => each.kind === 'impersonation')?.detail).toMatchObject({
      verifiedName: 'Khaadi',
      name: 'Khadi Official Store',
    });
    expect(standing.find((each) => each.kind === 'cloned_catalogue')?.detail).toMatchObject({
      otherShopId: brand,
      same: 6,
      own: 6,
    });

    // Cleared, a sign isn't raised again for its store; the rest stand.
    expect(
      await signals.clear(
        'quick-deals',
        'prepaid_unshipped',
        'Ayesha',
        'Pre-orders: told shoppers',
      ),
    ).toBe(true);
    expect(await signals.clear('quick-deals', 'prepaid_unshipped', 'Ayesha', 'Again')).toBe(false);
    await signals.scan(new Date(at.getTime() + 86_400_000));
    expect((await signals.list()).map((each) => each.kind).sort()).toEqual([
      'cloned_catalogue',
      'impersonation',
    ]);
    const all = await signals.list({ all: true });
    expect(all.find((each) => each.kind === 'prepaid_unshipped')).toMatchObject({
      clearedBy: 'Ayesha',
      note: 'Pre-orders: told shoppers',
    });
    await expect(signals.clear('khadi-official', 'impersonation', ' ', 'x')).rejects.toThrow();
  });
});
