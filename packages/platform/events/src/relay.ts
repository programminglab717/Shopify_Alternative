import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { silentLogger, type DomainEvent, type EventsLogger } from './event.js';

/** Hands events to the transport. Must be idempotent per event id. */
export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

export interface OutboxRelayOptions {
  /** A system-role database: the relay reads every shop's events. */
  db: Db;
  publisher: EventPublisher;
  batchSize?: number;
  /** Fallback poll interval. With `listenUrl`, new events wake the relay immediately. */
  pollIntervalMs?: number;
  /** Connection used for LISTEN; must be a direct session, not a transaction-mode pooler. */
  listenUrl?: string;
  /**
   * Publish attempts after which an event that the transport keeps rejecting, while others get
   * through, is parked: left unpublished with its last error, for someone to inspect.
   */
  maxAttempts?: number;
  logger?: EventsLogger;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  shop_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
}

const CHANNEL = 'hatti_outbox';
const MAX_BACKOFF_MS = 30_000;
const LISTEN_RETRY_MS = 30_000;

function toEvent(row: OutboxRow): DomainEvent {
  return {
    id: row.id,
    type: row.event_type,
    shopId: row.shop_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

/**
 * Moves committed events from the outbox to the publisher. Batches are claimed with
 * FOR UPDATE SKIP LOCKED, so several relays can run at once without publishing an event twice
 * in the normal case; a crash between publishing and marking can repeat a batch, which consumers
 * absorb by deduplicating on the event id.
 */
export class OutboxRelay {
  readonly #db: Db;
  readonly #publisher: EventPublisher;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #listenUrl: string | undefined;
  readonly #maxAttempts: number;
  readonly #logger: EventsLogger;

  #running = false;
  #loop: Promise<void> | undefined;
  #failures = 0;
  #listener: pg.Client | undefined;
  #nextListenAttempt = 0;
  #wakePending = false;
  #wake: (() => void) | undefined;

  constructor(options: OutboxRelayOptions) {
    this.#db = options.db;
    this.#publisher = options.publisher;
    this.#batchSize = options.batchSize ?? 100;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#listenUrl = options.listenUrl;
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Publishes up to one batch and returns how many events it published.
   *
   * If the transport rejects the batch, events are retried one at a time. When some get through,
   * the rest are counted as failed attempts, so a single bad event cannot hold up every shop's
   * events. When none get through, the transport is down: nothing is counted against the events
   * and the error is rethrown so the caller backs off.
   */
  async relayBatch(): Promise<number> {
    let outage: unknown;
    const published = await this.#db.transaction(async (tx) => {
      const { rows } = await tx.execute<OutboxRow>(sql`
        select id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at
          from platform.outbox_events
         where published_at is null and attempts < ${this.#maxAttempts}
         order by occurred_at, id
         limit ${this.#batchSize}
         for update skip locked
      `);
      if (rows.length === 0) return 0;
      const events = rows.map(toEvent);

      let delivered = events;
      const failed = new Map<string, unknown>();
      try {
        await this.#publisher.publish(events);
      } catch (batchError) {
        delivered = [];
        for (const event of events) {
          try {
            await this.#publisher.publish([event]);
            delivered.push(event);
          } catch (error) {
            failed.set(event.id, error);
          }
        }
        if (delivered.length === 0) {
          outage = batchError;
          await tx.execute(sql`
            update platform.outbox_events
               set last_error = ${String(batchError).slice(0, 1_000)}
             where id = any(${sql.param(events.map((event) => event.id))}::uuid[])
          `);
          return 0;
        }
      }

      await tx.execute(sql`
        update platform.outbox_events
           set published_at = now(), attempts = attempts + 1, last_error = null
         where id = any(${sql.param(delivered.map((event) => event.id))}::uuid[])
      `);
      for (const [id, error] of failed) {
        const { rows: updated } = await tx.execute<{ attempts: number }>(sql`
          update platform.outbox_events
             set attempts = attempts + 1, last_error = ${String(error).slice(0, 1_000)}
           where id = ${id}
          returning attempts
        `);
        const attempts = updated[0]?.attempts ?? 0;
        const parked = attempts >= this.#maxAttempts;
        this.#logger[parked ? 'error' : 'warn'](
          { err: error, eventId: id, attempts },
          parked ? 'outbox event parked after repeated failures' : 'outbox event not published',
        );
      }
      return delivered.length;
    });
    if (outage !== undefined) throw outage;
    return published;
  }

  /** Runs until {@link stop}: drains the outbox, then waits for a notification or the poll timer. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#wake?.();
    await this.#loop;
    this.#loop = undefined;
    const listener = this.#listener;
    this.#listener = undefined;
    await listener?.end().catch(() => {});
  }

  async #run(): Promise<void> {
    while (this.#running) {
      await this.#ensureListening();
      let published = 0;
      try {
        published = await this.relayBatch();
        this.#failures = 0;
        if (published > 0) this.#logger.debug({ published }, 'outbox events published');
      } catch (error) {
        this.#failures += 1;
        this.#logger.error({ err: error, failures: this.#failures }, 'outbox relay failed');
      }
      // A full batch means more are probably waiting.
      if (published === this.#batchSize) continue;
      const delay =
        this.#failures > 0
          ? Math.min(MAX_BACKOFF_MS, this.#pollIntervalMs * 2 ** this.#failures)
          : this.#pollIntervalMs;
      await this.#sleep(delay);
    }
  }

  #sleep(ms: number): Promise<void> {
    if (this.#wakePending || !this.#running) {
      this.#wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#wake = undefined;
        this.#wakePending = false;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }

  #notify(): void {
    if (this.#wake) this.#wake();
    else this.#wakePending = true;
  }

  async #ensureListening(): Promise<void> {
    if (!this.#listenUrl || this.#listener || Date.now() < this.#nextListenAttempt) return;
    const client = new pg.Client({
      connectionString: this.#listenUrl,
      application_name: 'hatti-outbox-relay',
    });
    client.on('notification', () => this.#notify());
    client.on('error', (error) => {
      this.#logger.warn({ err: error }, 'outbox listener lost; polling until it reconnects');
      if (this.#listener === client) this.#listener = undefined;
      this.#nextListenAttempt = Date.now() + LISTEN_RETRY_MS;
      client.end().catch(() => {});
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.#listener = client;
    } catch (error) {
      this.#logger.warn({ err: error }, 'could not LISTEN for outbox events; polling instead');
      this.#nextListenAttempt = Date.now() + LISTEN_RETRY_MS;
      await client.end().catch(() => {});
    }
  }
}
