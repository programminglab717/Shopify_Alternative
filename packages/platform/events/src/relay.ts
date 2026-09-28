import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '@hatti/db';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  metrics,
  propagation,
  trace,
  type BatchObservableCallback,
  type Counter,
  type Link,
  type Meter,
  type ObservableGauge,
} from '@opentelemetry/api';
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
  /**
   * Connection used for LISTEN. It must be a direct session: through a transaction-mode pooler,
   * notifications go to whichever connection happens to be listening. The relay checks this when
   * it starts listening, and polls instead if notifications do not arrive.
   */
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
  trace_context: string | null;
}

const CHANNEL = 'hatti_outbox';
const MAX_BACKOFF_MS = 30_000;
const LISTEN_RETRY_MS = 30_000;
const LISTEN_CHECK_TIMEOUT_MS = 2_000;

function toEvent(row: OutboxRow): DomainEvent {
  return {
    id: row.id,
    type: row.event_type,
    shopId: row.shop_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at).toISOString(),
    ...(row.trace_context ? { traceparent: row.trace_context } : {}),
  };
}

/** Links a relay batch to the requests that recorded its events. */
function linksOf(events: readonly DomainEvent[]): Link[] {
  return events.flatMap((event) => {
    if (!event.traceparent) return [];
    const context = propagation.extract(ROOT_CONTEXT, { traceparent: event.traceparent });
    const spanContext = trace.getSpanContext(context);
    return spanContext ? [{ context: spanContext }] : [];
  });
}

const tracer = trace.getTracer('hatti.events');

interface RelayInstruments {
  published: Counter;
  rejected: Counter;
  outages: Counter;
  lag: ObservableGauge;
  parked: ObservableGauge;
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
  /** Set when notifications never arrived on the LISTEN connection; the relay then only polls. */
  #listenUnusable = false;
  #wakePending = false;
  #wake: (() => void) | undefined;

  // Created per relay, after telemetry has started, so they record rather than no-op.
  readonly #meter: Meter;
  readonly #instruments: RelayInstruments;

  constructor(options: OutboxRelayOptions) {
    this.#db = options.db;
    this.#publisher = options.publisher;
    this.#batchSize = options.batchSize ?? 100;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#listenUrl = options.listenUrl;
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#logger = options.logger ?? silentLogger;
    this.#meter = metrics.getMeter('hatti.events');
    this.#instruments = {
      published: this.#meter.createCounter('hatti.outbox.events.published', {
        description: 'Events handed to the queue',
      }),
      rejected: this.#meter.createCounter('hatti.outbox.events.rejected', {
        description: 'Failed attempts to publish one event while others got through',
      }),
      outages: this.#meter.createCounter('hatti.outbox.relay.outages', {
        description: 'Batches not published because the queue was unreachable',
      }),
      lag: this.#meter.createObservableGauge('hatti.outbox.lag', {
        unit: 's',
        description: 'Age of the oldest event waiting to be published',
      }),
      parked: this.#meter.createObservableGauge('hatti.outbox.parked', {
        description: 'Events parked after repeated failures, waiting for someone to look',
      }),
    };
  }

  /** Reports outbox lag and parked events when metrics are collected. */
  readonly #observe: BatchObservableCallback = async (result) => {
    const { rows } = await this.#db.execute<{ lag: string | null; parked: string }>(sql`
      select coalesce(extract(epoch from now() - min(occurred_at)
                        filter (where attempts < ${this.#maxAttempts})), 0) as lag,
             count(*) filter (where attempts >= ${this.#maxAttempts}) as parked
        from platform.outbox_events
       where published_at is null
    `);
    result.observe(this.#instruments.lag, Number(rows[0]?.lag ?? 0));
    result.observe(this.#instruments.parked, Number(rows[0]?.parked ?? 0));
  };

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
        select id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at,
               trace_context
          from platform.outbox_events
         where published_at is null and attempts < ${this.#maxAttempts}
         order by occurred_at, id
         limit ${this.#batchSize}
         for update skip locked
      `);
      if (rows.length === 0) return 0;
      const events = rows.map(toEvent);
      // A span only for batches with work, so idle polling leaves no trace.
      return tracer.startActiveSpan(
        'outbox publish',
        {
          kind: SpanKind.PRODUCER,
          attributes: { 'messaging.batch.message_count': events.length },
          links: linksOf(events),
        },
        async (span) => {
          try {
            const result = await this.#publish(tx, events);
            if (result.outage !== undefined) {
              outage = result.outage;
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'queue unavailable' });
            }
            return result.delivered;
          } finally {
            span.end();
          }
        },
      );
    });
    if (outage !== undefined) {
      this.#instruments.outages.add(1);
      throw outage;
    }
    return published;
  }

  async #publish(tx: Tx, events: DomainEvent[]): Promise<{ delivered: number; outage?: unknown }> {
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
        await tx.execute(sql`
          update platform.outbox_events
             set last_error = ${String(batchError).slice(0, 1_000)}
           where id = any(${sql.param(events.map((event) => event.id))}::uuid[])
        `);
        return { delivered: 0, outage: batchError };
      }
    }

    await tx.execute(sql`
      update platform.outbox_events
         set published_at = now(), attempts = attempts + 1, last_error = null
       where id = any(${sql.param(delivered.map((event) => event.id))}::uuid[])
    `);
    this.#instruments.published.add(delivered.length);
    for (const [id, error] of failed) {
      const { rows: updated } = await tx.execute<{ attempts: number }>(sql`
        update platform.outbox_events
           set attempts = attempts + 1, last_error = ${String(error).slice(0, 1_000)}
         where id = ${id}
        returning attempts
      `);
      this.#instruments.rejected.add(1);
      const attempts = updated[0]?.attempts ?? 0;
      const parked = attempts >= this.#maxAttempts;
      this.#logger[parked ? 'error' : 'warn'](
        { err: error, eventId: id, attempts },
        parked ? 'outbox event parked after repeated failures' : 'outbox event not published',
      );
    }
    return { delivered: delivered.length };
  }

  /** Runs until {@link stop}: drains the outbox, then waits for a notification or the poll timer. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#meter.addBatchObservableCallback(this.#observe, [
      this.#instruments.lag,
      this.#instruments.parked,
    ]);
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    if (this.#running) {
      this.#meter.removeBatchObservableCallback(this.#observe, [
        this.#instruments.lag,
        this.#instruments.parked,
      ]);
    }
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
    if (
      !this.#listenUrl ||
      this.#listener ||
      this.#listenUnusable ||
      Date.now() < this.#nextListenAttempt
    ) {
      return;
    }
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
      if (!(await this.#receivesNotifications(client))) {
        this.#listenUnusable = true;
        this.#logger.warn(
          { channel: CHANNEL },
          'no notifications arrive on the outbox LISTEN connection, as happens through a ' +
            'transaction-mode pooler; give the relay a direct connection (DATABASE_LISTEN_URL). ' +
            'Polling instead',
        );
        await client.end().catch(() => {});
        return;
      }
      this.#listener = client;
    } catch (error) {
      this.#logger.warn({ err: error }, 'could not LISTEN for outbox events; polling instead');
      this.#nextListenAttempt = Date.now() + LISTEN_RETRY_MS;
      await client.end().catch(() => {});
    }
  }

  /**
   * Sends a notification from the relay's other connection and waits for it on the listener. From
   * the listener's own connection it would always arrive, even through a pooler, because a session
   * receives its own notifications.
   */
  async #receivesNotifications(listener: pg.Client): Promise<boolean> {
    const probe = `probe:${randomUUID()}`;
    let onNotification: ((message: pg.Notification) => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const received = new Promise<boolean>((resolve) => {
      onNotification = (message) => {
        if (message.payload === probe) resolve(true);
      };
      listener.on('notification', onNotification);
      timer = setTimeout(() => resolve(false), LISTEN_CHECK_TIMEOUT_MS);
    });
    try {
      await this.#db.execute(sql`select pg_notify(${CHANNEL}, ${probe})`);
      return await received;
    } finally {
      clearTimeout(timer);
      if (onNotification) listener.off('notification', onNotification);
    }
  }
}
