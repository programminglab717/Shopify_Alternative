import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { createLogger } from '@hatti/logger';
import { FulfillmentService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskRescoring } from './risk-rescoring.js';
import { eventHandlers } from './start-worker.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe.skipIf(!server)("Scoring orders again as their customer's history changes", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  const shopId = newId();
  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_orders']),
  };

  /** The events recorded since the last call, oldest first, as the relay hands them on. */
  const recorded = async (): Promise<DomainEvent[]> => {
    const { rows } = await admin.query<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(`
      UPDATE platform.outbox_events SET published_at = now()
       WHERE published_at IS NULL
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

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'risk-rescoring-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A')`, [shopId]);
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  it("holds a customer's waiting order once a parcel of theirs is refused", async () => {
    const product = unwrap(
      await new ProductService(database).create(tenant, {
        title: 'Kurta',
        status: 'active',
        variants: [{ price: '2,000' }],
      }),
    );
    const variantId = product.variants[0]!.id;
    const location = await new LocationService(database).primary(tenant);
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(tenant, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 10 }],
      }),
    );
    const orders = workerOrders(database);
    const fulfillments = new FulfillmentService(database, new StockService());
    const place = async () =>
      unwrap(
        await orders.create(tenant, {
          lineItems: [{ variantId, quantity: 1 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: '0300 1112223',
            address1: 'House 12, Street 4',
            city: 'Lahore',
          },
        }),
      );
    const first = await place();
    unwrap(await orders.confirm(tenant, first.id));
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(tenant, first.id, {}));
    const waiting = await place();
    const later = await place();
    expect(later).toMatchObject({ stage: 'needs_confirmation', risk: { score: 25 } });

    // The worker dispatches each event to its handlers, as the queue hands them over: placing
    // and shipping change no one's history, the refusal does.
    const handlers = eventHandlers(
      createLogger({ name: 'worker', level: 'silent' }),
      undefined,
      undefined,
      new RiskRescoring(orders),
    );
    for (const event of await recorded()) await handlers.dispatch(event);
    expect(await orders.get(tenant, later.id)).toMatchObject({ risk: { score: 25 } });

    unwrap(await fulfillments.markReturning(tenant, fulfillmentId));
    const refused = await recorded();
    expect(refused.map((event) => event.type)).toEqual(['fulfillment.updated']);
    await handlers.dispatch(refused[0]!);
    expect(await orders.get(tenant, waiting.id)).toMatchObject({
      stage: 'needs_confirmation',
      risk: { score: 35, level: 'medium' },
    });
    expect(await orders.get(tenant, later.id)).toMatchObject({
      stage: 'needs_review',
      risk: { score: 60, level: 'high' },
    });
    // Handled again, as a queue may: nothing more changes.
    await handlers.dispatch(refused[0]!);
    const rescored = (await recorded()).filter((event) => event.type === 'order.updated');
    expect(rescored.map((event) => [event.aggregateId, event.payload.changed])).toEqual([
      [waiting.id, ['risk']],
      [later.id, ['risk']],
    ]);
  });

  it('reads only the events that change a history', () => {
    expect(RiskRescoring.EVENTS).toEqual([
      'fulfillment.updated',
      'order.cancelled',
      'customer.merged',
    ]);
  });
});
