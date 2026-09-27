import { randomBytes } from 'node:crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BullMqEventPublisher,
  EventHandlerRegistry,
  OutboxRelay,
  appendEvent,
  createEventQueue,
  createEventWorker,
  createRedis,
  type DomainEvent,
  type EventPublisher,
} from './index.js';

const server = testDatabaseServer();
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
    await admin.query('DELETE FROM platform.outbox_events');
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
        listenUrl: testDb.systemUrl,
      });
      relay.start();
      // Let the relay drain the empty outbox and start listening.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const event = await append();
      await vi.waitFor(() => expect(publisher.published.map((e) => e.id)).toEqual([event.id]), {
        timeout: 3_000,
      });
    });

    it('stops promptly', async () => {
      relay = new OutboxRelay({ db: db.systemDb, publisher: new MemoryPublisher() });
      relay.start();
      const started = Date.now();
      await relay.stop();
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  describe.skipIf(!redisUrl)('BullMQ transport', () => {
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
