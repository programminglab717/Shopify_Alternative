import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { CollectionService, ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { shopRedirectsOf } from '@hatti/online-store/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandleRedirects } from './handle-redirects.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe.skipIf(!server)("Redirects from products' and collections' old addresses", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let products: ProductService;
  let collections: CollectionService;
  let redirects: HandleRedirects;
  const shopId = newId();
  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products']),
  };

  /** The catalog's update events recorded since the last call, oldest first. */
  const updates = async (): Promise<DomainEvent[]> => {
    const { rows } = await admin.query<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(`
      UPDATE platform.outbox_events SET published_at = now()
       WHERE published_at IS NULL AND event_type IN ('product.updated', 'collection.updated')
      RETURNING id, aggregate_type, aggregate_id, event_type, payload, occurred_at`);
    return rows
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || (a.id < b.id ? -1 : 1))
      .map((row) => ({
        id: row.id,
        type: row.event_type,
        shopId,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.occurred_at.toISOString(),
      }));
  };
  const redirectsNow = () => database.tenant(shopId, (tx) => shopRedirectsOf(tx, shopId));

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({ appUrl: testDb.appUrl, applicationName: 'handle-redirects-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shopId,
    ]);
    products = new ProductService(database);
    collections = new CollectionService(database);
    redirects = new HandleRedirects(database, { products, collections });
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  it('sends every old address to where the product is now, however late or out of order the events come', async () => {
    const lawn = unwrap(await products.create(tenant, { title: 'Lawn Suit' }));
    const rename = async (handle: string, redirectNewHandle?: boolean) =>
      unwrap(await products.update(tenant, { id: lawn.id, handle, redirectNewHandle }));
    await rename('lawn-2026', true);
    await rename('lawn-3-piece', true);
    // Not asked: its old address is not sent on.
    await rename('lawn-three-piece');
    const events = await updates();
    expect(events).toHaveLength(3);
    for (const event of events.reverse()) await redirects.handle(event);
    expect(await redirectsNow()).toEqual([
      { path: '/products/lawn-2026', target: '/products/lawn-three-piece' },
      { path: '/products/lawn-suit', target: '/products/lawn-three-piece' },
    ]);

    // Back at an old handle: that address sends nobody away, the others follow it there.
    await rename('lawn-suit', true);
    for (const event of await updates()) await redirects.handle(event);
    expect(await redirectsNow()).toEqual([
      { path: '/products/lawn-2026', target: '/products/lawn-suit' },
      { path: '/products/lawn-three-piece', target: '/products/lawn-suit' },
    ]);
  });

  it("sends a collection's old address to its new one, and none for one deleted since", async () => {
    const eid = unwrap(await collections.create(tenant, { title: 'Eid Edit' }));
    unwrap(
      await collections.update(tenant, { id: eid.id, handle: 'eid', redirectNewHandle: true }),
    );
    for (const event of await updates()) await redirects.handle(event);
    expect(await redirectsNow()).toContainEqual({
      path: '/collections/eid-edit',
      target: '/collections/eid',
    });

    const khussa = unwrap(await products.create(tenant, { title: 'Khussa' }));
    unwrap(
      await products.update(tenant, { id: khussa.id, handle: 'khussa-2', redirectNewHandle: true }),
    );
    unwrap(await products.delete(tenant, khussa.id));
    for (const event of await updates()) await redirects.handle(event);
    expect((await redirectsNow()).map((redirect) => redirect.path)).not.toContain(
      '/products/khussa',
    );
  });
});
