import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  metrics,
  propagation,
  trace,
} from '@opentelemetry/api';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { silentLogger, type DomainEvent, type EventsLogger } from './event.js';
import type { EventPublisher } from './relay.js';

export const DOMAIN_EVENTS_QUEUE = 'domain-events';

/**
 * A Redis connection for BullMQ. Workers block on Redis and wait out outages (BullMQ requires
 * unlimited retries for them). Producers fail fast instead, so the outbox relay backs off and API
 * readiness checks report an outage at once rather than hanging.
 */
export function createRedis(url: string, role: 'producer' | 'worker'): Redis {
  return role === 'worker'
    ? new Redis(url, { maxRetriesPerRequest: null })
    : new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
}

export interface QueueLocation {
  connection: Redis;
  /** Defaults to DOMAIN_EVENTS_QUEUE. */
  queueName?: string;
  /** Redis key prefix; tests use a unique one. */
  prefix?: string;
}

export function createEventQueue(location: QueueLocation): Queue<DomainEvent> {
  return new Queue<DomainEvent>(location.queueName ?? DOMAIN_EVENTS_QUEUE, {
    connection: location.connection,
    prefix: location.prefix,
  });
}

/** Publishes events as BullMQ jobs whose id is the event id, so a repeated batch is ignored. */
export class BullMqEventPublisher implements EventPublisher {
  constructor(private readonly queue: Queue<DomainEvent>) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    await this.queue.addBulk(
      events.map((event) => ({
        name: event.type,
        data: event,
        opts: {
          jobId: event.id,
          attempts: 10,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 24 * 3600, count: 10_000 },
          removeOnFail: { age: 14 * 24 * 3600 },
        },
      })),
    );
  }
}

export type EventHandler = (event: DomainEvent) => Promise<void>;

/**
 * Maps event types to handlers. "*" receives every event. A failing handler fails the job, and
 * the retry runs every handler again, so handlers must be idempotent.
 */
export class EventHandlerRegistry {
  readonly #handlers = new Map<string, EventHandler[]>();

  on(type: string, handler: EventHandler): this {
    this.#handlers.set(type, [...(this.#handlers.get(type) ?? []), handler]);
    return this;
  }

  handlersFor(type: string): EventHandler[] {
    return [...(this.#handlers.get(type) ?? []), ...(this.#handlers.get('*') ?? [])];
  }

  async dispatch(event: DomainEvent): Promise<void> {
    for (const handler of this.handlersFor(event.type)) await handler(event);
  }
}

export interface EventWorkerOptions extends QueueLocation {
  registry: EventHandlerRegistry;
  concurrency?: number;
  logger?: EventsLogger;
}

/**
 * A BullMQ worker that dispatches domain events to the registry. Each event is handled in a
 * consumer span that continues the trace of the request that recorded it.
 */
export function createEventWorker(options: EventWorkerOptions): Worker<DomainEvent> {
  const logger = options.logger ?? silentLogger;
  const queueName = options.queueName ?? DOMAIN_EVENTS_QUEUE;
  const tracer = trace.getTracer('hatti.events');
  const duration = metrics
    .getMeter('hatti.events')
    .createHistogram('hatti.events.handle.duration', {
      unit: 'ms',
      description: 'Time to run every handler for one event',
    });

  const handle = (event: DomainEvent) => {
    const parent = event.traceparent
      ? propagation.extract(ROOT_CONTEXT, { traceparent: event.traceparent })
      : ROOT_CONTEXT;
    const attributes = {
      'messaging.system': 'bullmq',
      'messaging.destination.name': queueName,
      'messaging.operation.type': 'process',
      'messaging.message.id': event.id,
      'hatti.event_type': event.type,
      'hatti.shop_id': event.shopId,
    };
    return tracer.startActiveSpan(
      `process ${event.type}`,
      { kind: SpanKind.CONSUMER, attributes },
      parent,
      async (span) => {
        const started = performance.now();
        let outcome = 'ok';
        try {
          await options.registry.dispatch(event);
        } catch (error) {
          outcome = 'error';
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
          duration.record(performance.now() - started, { 'hatti.event_type': event.type, outcome });
        }
      },
    );
  };

  const worker = new Worker<DomainEvent>(
    queueName,
    async (job: Job<DomainEvent>) => {
      await handle(job.data);
    },
    {
      connection: options.connection,
      prefix: options.prefix,
      concurrency: options.concurrency ?? 10,
    },
  );
  worker.on('failed', (job, error) => {
    logger.error(
      { err: error, eventId: job?.data.id, eventType: job?.data.type, attempts: job?.attemptsMade },
      'event handler failed',
    );
  });
  worker.on('error', (error) => logger.error({ err: error }, 'event worker error'));
  return worker;
}
