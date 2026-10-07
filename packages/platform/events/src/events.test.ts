import { randomBytes } from 'node:crypto';
import { Database } from '@hatti/db';
import {
  createTestDatabase,
  testDatabaseServer,
  testPoolerServer,
  type TestDatabase,
} from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BullMqEventPublisher,
  EventHandlerRegistry,
  OutboxRelay,
  actingAs,
  appendEvent,
  appendEvents,
  currentActor,
  listActivity,
  createEventQueue,
  createEventWorker,
  createRedis,
  silentLogger,
  type DomainEvent,
  type EventPublisher,
} from './index.js';

// Real tracing in this file, to check that traces survive the trip through the outbox.
const spans = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const server = testDatabaseServer();
const pooler = testPoolerServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

class MemoryPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];
  /** Every publish fails, as when Redis is unreachable. */
  down = false;
  /** Events the transport always rejects, e.g. because they are too large. */
  rejects: (event: DomainEvent) => boolean = () => false;
  delayMs = 0;

  async publish(events: readonly DomainEvent[]): Promise<void> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.down) throw new Error('transport down');
    const rejected = events.find(this.rejects);
    if (rejected) throw new Error(`rejected ${rejected.id}`);
    this.published.push(...events);
  }
}

describe.skipIf(!server)('outbox', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  const shopId = newId();

  const append = (type = 'product.updated') =>
    db.tenant(shopId, (tx) =>
      appendEvent(tx, shopId, {
        type,
        aggregateType: 'product',
        aggregateId: newId(),
        payload: { title: 'Lawn suit' },
      }),
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    db = new Database({ appUrl: testDb.appUrl, systemUrl: testDb.systemUrl, applicationName: 't' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM platform.outbox_events; DELETE FROM platform.activity_log');
  });

  it('records events only when the transaction commits', async () => {
    const event = await append();
    await expect(
      db.tenant(shopId, async (tx) => {
        await appendEvent(tx, shopId, {
          type: 'product.deleted',
          aggregateType: 'product',
          aggregateId: newId(),
          payload: {},
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const { rows } = await admin.query(
      'SELECT id, event_type, payload FROM platform.outbox_events',
    );
    expect(rows).toEqual([
      { id: event.id, event_type: 'product.updated', payload: { title: 'Lawn suit' } },
    ]);
  });

  it("carries who made it where a request says, and lists the shop's activity by it (ADR-256)", async () => {
    const ayesha = { kind: 'staff' as const, id: newId(), role: 'manager' };
    const app = { kind: 'app' as const, id: newId(), role: null };
    // The worker's own: no one.
    const swept = await append('product.updated');
    const created = await actingAs(ayesha, () => append('product.created'));
    const [first, second] = await actingAs(app, async () => {
      expect(currentActor()).toEqual(app);
      // Through any number of awaits, and every event of one statement.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return db.tenant(shopId, (tx) =>
        appendEvents(tx, shopId, [
          {
            type: 'collection.updated',
            aggregateType: 'collection',
            aggregateId: newId(),
            payload: {},
          },
          {
            type: 'tax_settings.updated',
            aggregateType: 'tax_settings',
            aggregateId: shopId,
            payload: {},
          },
        ]),
      );
    });
    expect(currentActor()).toBeNull();
    // Only if what it describes commits.
    await expect(
      actingAs(ayesha, () =>
        db.tenant(shopId, async (tx) => {
          await appendEvent(tx, shopId, {
            type: 'product.deleted',
            aggregateType: 'product',
            aggregateId: newId(),
            payload: {},
          });
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    // Each is in the outbox all the same; the request's on the activity log too, by whom.
    const outbox = await admin.query<{ id: string }>(
      'SELECT id FROM platform.outbox_events ORDER BY id',
    );
    expect(outbox.rows.map((row) => row.id)).toEqual([swept.id, created.id, first!.id, second!.id]);
    const { rows } = await admin.query(
      `SELECT id, event_type, actor_kind, actor_id, actor_role
         FROM platform.activity_log ORDER BY id`,
    );
    expect(rows).toEqual([
      {
        id: created.id,
        event_type: 'product.created',
        actor_kind: 'staff',
        actor_id: ayesha.id,
        actor_role: 'manager',
      },
      {
        id: first!.id,
        event_type: 'collection.updated',
        actor_kind: 'app',
        actor_id: app.id,
        actor_role: null,
      },
      {
        id: second!.id,
        event_type: 'tax_settings.updated',
        actor_kind: 'app',
        actor_id: app.id,
        actor_role: null,
      },
    ]);

    // The shop's activity: what its staff and apps did, the latest first, never what it recorded.
    const page = await db.tenant(shopId, (tx) => listActivity(tx, shopId, { first: 2 }));
    expect(page.hasNextPage).toBe(true);
    expect(page.items).toEqual([
      {
        id: second!.id,
        type: 'tax_settings.updated',
        aggregateType: 'tax_settings',
        aggregateId: shopId,
        actor: app,
        occurredAt: expect.any(Date),
      },
      expect.objectContaining({ id: first!.id, type: 'collection.updated' }),
    ]);
    const rest = await db.tenant(shopId, (tx) =>
      listActivity(tx, shopId, { first: 2, after: first!.id }),
    );
    expect(rest).toEqual({
      items: [expect.objectContaining({ id: created.id, actor: ayesha })],
      hasNextPage: false,
    });
    const ids = async (query: { aggregateId?: string; type?: string }) =>
      (
        await db.tenant(shopId, (tx) => listActivity(tx, shopId, { first: 10, ...query }))
      ).items.map((item) => item.id);
    expect(await ids({ aggregateId: created.aggregateId })).toEqual([created.id]);
    expect(await ids({ type: 'collection.updated' })).toEqual([first!.id]);
    // Another shop's transaction sees none of it, whichever shop it asks for.
    const elsewhere = newId();
    expect(await db.tenant(elsewhere, (tx) => listActivity(tx, shopId, { first: 10 }))).toEqual({
      items: [],
      hasNextPage: false,
    });
  });

  it('records several events with one statement, in order', async () => {
    const aggregateIds = [newId(), newId(), newId()];
    const recorded = await db.tenant(shopId, (tx) =>
      appendEvents(
        tx,
        shopId,
        aggregateIds.map((aggregateId, index) => ({
          type: 'inventory_level.updated',
          aggregateType: 'inventory_level',
          aggregateId,
          payload: { available: index, note: 'Stock count: "Lahore" \\ 1' },
        })),
      ),
    );
    expect(await db.tenant(shopId, (tx) => appendEvents(tx, shopId, []))).toEqual([]);

    const publisher = new MemoryPublisher();
    await new OutboxRelay({ db: db.systemDb, publisher }).relayBatch();
    expect(publisher.published).toEqual(recorded);
    expect(publisher.published.map((event) => event.aggregateId)).toEqual(aggregateIds);
    expect(publisher.published[2]!.payload).toEqual({
      available: 2,
      note: 'Stock count: "Lahore" \\ 1',
    });
  });

  it('publishes in order and marks events published', async () => {
    const first = await append('a.first');
    const second = await append('a.second');
    const publisher = new MemoryPublisher();
    const relay = new OutboxRelay({ db: db.systemDb, publisher });

    expect(await relay.relayBatch()).toBe(2);
    expect(publisher.published.map((e) => e.id)).toEqual([first.id, second.id]);
    expect(publisher.published[0]).toEqual(first);
    expect(await relay.relayBatch()).toBe(0);
    expect(publisher.published).toHaveLength(2);
  });

  it('backs off without using up attempts while the transport is down', async () => {
    const event = await append();
    const publisher = new MemoryPublisher();
    publisher.down = true;
    const relay = new OutboxRelay({ db: db.systemDb, publisher });

    await expect(relay.relayBatch()).rejects.toThrow('transport down');
    const { rows } = await admin.query(
      'SELECT attempts, last_error, published_at FROM platform.outbox_events WHERE id = $1',
      [event.id],
    );
    expect(rows[0]).toMatchObject({ attempts: 0, published_at: null });
    expect(rows[0].last_error).toContain('transport down');

    publisher.down = false;
    expect(await relay.relayBatch()).toBe(1);
    expect(publisher.published.map((e) => e.id)).toEqual([event.id]);
  });

  it('parks an event the transport keeps rejecting without holding up others', async () => {
    const bad = await append('a.bad');
    const publisher = new MemoryPublisher();
    publisher.rejects = (event) => event.id === bad.id;
    const relay = new OutboxRelay({ db: db.systemDb, publisher, maxAttempts: 3 });

    const good: string[] = [];
    for (let round = 0; round < 4; round++) {
      good.push((await append('a.good')).id);
      expect(await relay.relayBatch()).toBe(1);
    }
    expect(await relay.relayBatch()).toBe(0);

    expect(publisher.published.map((e) => e.id)).toEqual(good);
    const { rows } = await admin.query(
      'SELECT attempts, last_error, published_at FROM platform.outbox_events WHERE id = $1',
      [bad.id],
    );
    expect(rows[0]).toMatchObject({ attempts: 3, published_at: null });
    expect(rows[0].last_error).toContain(`rejected ${bad.id}`);
  });

  it('never gives the same event to two concurrent relays', async () => {
    for (let i = 0; i < 30; i++) await append();
    const publishers = [new MemoryPublisher(), new MemoryPublisher(), new MemoryPublisher()];
    for (const publisher of publishers) publisher.delayMs = 20;
    const relays = publishers.map(
      (publisher) => new OutboxRelay({ db: db.systemDb, publisher, batchSize: 5 }),
    );

    const drain = async (relay: OutboxRelay) => {
      while ((await relay.relayBatch()) > 0);
    };
    await Promise.all(relays.map(drain));

    const ids = publishers.flatMap((publisher) => publisher.published.map((e) => e.id));
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  describe('running relay', () => {
    let relay: OutboxRelay | undefined;
    afterEach(async () => {
      await relay?.stop();
      relay = undefined;
    });

    it('wakes on NOTIFY instead of waiting for the next poll', async () => {
      const publisher = new MemoryPublisher();
      relay = new OutboxRelay({
        db: db.systemDb,
        publisher,
        pollIntervalMs: 60_000,
        listenUrl: testDb.listenUrl,
      });
      relay.start();
      // Let the relay drain the empty outbox and start listening.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const event = await append();
      await vi.waitFor(() => expect(publisher.published.map((e) => e.id)).toEqual([event.id]), {
        timeout: 3_000,
      });
    });

    it.skipIf(!pooler)(
      'polls, and says why, when its LISTEN connection goes through a transaction pooler',
      async () => {
        const publisher = new MemoryPublisher();
        const warnings: string[] = [];
        relay = new OutboxRelay({
          db: db.systemDb,
          publisher,
          pollIntervalMs: 200,
          listenUrl: testDb.systemUrl,
          logger: { ...silentLogger, warn: (_details, message) => warnings.push(message ?? '') },
        });
        relay.start();
        await vi.waitFor(() => expect(warnings.join('\n')).toMatch(/transaction-mode pooler/), {
          timeout: 10_000,
        });
        const event = await append();
        await vi.waitFor(() => expect(publisher.published.map((e) => e.id)).toContain(event.id), {
          timeout: 3_000,
        });
      },
    );

    it('stops promptly', async () => {
      relay = new OutboxRelay({ db: db.systemDb, publisher: new MemoryPublisher() });
      relay.start();
      const started = Date.now();
      await relay.stop();
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  describe.skipIf(!redisUrl)('BullMQ transport', () => {
    it('continues the trace of the request that recorded an event', async () => {
      const prefix = `test-${randomBytes(4).toString('hex')}`;
      const connection = createRedis(redisUrl!, 'producer');
      const workerConnection = createRedis(redisUrl!, 'worker');
      const queue = createEventQueue({ connection, prefix });
      const handled: DomainEvent[] = [];
      const registry = new EventHandlerRegistry().on('*', async (event) => {
        handled.push(event);
      });
      const worker = createEventWorker({ connection: workerConnection, prefix, registry });
      try {
        spans.reset();
        const request = trace.getTracer('test').startSpan('POST /graphql');
        const event = await context.with(trace.setSpan(context.active(), request), () =>
          append('product.created'),
        );
        request.end();
        const traceId = request.spanContext().traceId;
        expect(event.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));

        const relay = new OutboxRelay({
          db: db.systemDb,
          publisher: new BullMqEventPublisher(queue),
        });
        expect(await relay.relayBatch()).toBe(1);
        await vi.waitFor(() => expect(handled.map((e) => e.id)).toEqual([event.id]), {
          timeout: 5_000,
        });
        await vi.waitFor(() => {
          const finished = spans.getFinishedSpans();
          const consumer = finished.find((span) => span.name === 'process product.created');
          expect(consumer?.spanContext().traceId).toBe(traceId);
          expect(consumer?.attributes['hatti.shop_id']).toBe(shopId);
          const publish = finished.find((span) => span.name === 'outbox publish');
          expect(publish?.links.map((link) => link.context.traceId)).toContain(traceId);
        });
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
        connection.disconnect();
        workerConnection.disconnect();
      }
    });

    it('delivers events to handlers once per event id', async () => {
      const prefix = `test-${randomBytes(4).toString('hex')}`;
      const connection = createRedis(redisUrl!, 'producer');
      const workerConnection = createRedis(redisUrl!, 'worker');
      const queue = createEventQueue({ connection, prefix });
      const received: DomainEvent[] = [];
      const registry = new EventHandlerRegistry()
        .on('product.updated', async (event) => {
          received.push(event);
        })
        .on('*', async () => {});
      const worker = createEventWorker({ connection: workerConnection, prefix, registry });
      try {
        const publisher = new BullMqEventPublisher(queue);
        const event = await append();
        const relay = new OutboxRelay({ db: db.systemDb, publisher });
        expect(await relay.relayBatch()).toBe(1);
        // A repeated publish (e.g. after a crash before marking) is deduplicated by job id.
        await publisher.publish([event]);

        await vi.waitFor(() => expect(received.map((e) => e.id)).toEqual([event.id]), {
          timeout: 5_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(received).toHaveLength(1);
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
        connection.disconnect();
        workerConnection.disconnect();
      }
    });
  });
});
