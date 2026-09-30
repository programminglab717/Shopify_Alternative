import { Database } from '@hatti/db';
import {
  BullMqEventPublisher,
  EventHandlerRegistry,
  OutboxRelay,
  createEventQueue,
  createEventWorker,
  createRedis,
} from '@hatti/events';
import type { Logger } from '@hatti/logger';
import type { WorkerConfig } from '../config.js';
import {
  PUBLISHED_EVENTS,
  createStorefrontPublisher,
  type StorefrontPublisher,
} from '../storefront/publisher.js';

export interface RunningWorker {
  stop(): Promise<void>;
}

/** Event consumers. Modules add theirs here as they gain them (search indexing, webhooks, …). */
export function eventHandlers(
  logger: Logger,
  storefront?: StorefrontPublisher,
): EventHandlerRegistry {
  const registry = new EventHandlerRegistry().on('*', async (event) => {
    logger.info(
      {
        eventId: event.id,
        eventType: event.type,
        shopId: event.shopId,
        aggregateId: event.aggregateId,
      },
      'domain event',
    );
  });
  if (storefront) {
    for (const type of PUBLISHED_EVENTS) registry.on(type, (event) => storefront.handle(event));
  }
  return registry;
}

/** Starts the outbox relay and/or the event consumers, as WORKER_ROLES says. */
export async function startWorker(config: WorkerConfig, logger: Logger): Promise<RunningWorker> {
  const database = new Database({
    appUrl: config.DATABASE_URL,
    systemUrl: config.DATABASE_SYSTEM_URL,
    applicationName: 'core-worker',
    onError: (error) => logger.warn({ err: error }, 'idle database connection failed'),
  });
  const queueRedis = createRedis(config.REDIS_URL, 'producer');
  const queue = createEventQueue({ connection: queueRedis });
  const closers: (() => Promise<void>)[] = [];

  if (config.WORKER_ROLES.includes('relay')) {
    const relay = new OutboxRelay({
      db: database.systemDb,
      publisher: new BullMqEventPublisher(queue),
      pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
      listenUrl: config.DATABASE_LISTEN_URL ?? config.DATABASE_SYSTEM_URL,
      logger,
    });
    relay.start();
    closers.push(() => relay.stop());
  }

  if (config.WORKER_ROLES.includes('events')) {
    const workerRedis = createRedis(config.REDIS_URL, 'worker');
    // Its own connection: the queue's blocks while waiting for jobs.
    const storefrontRedis = createRedis(config.REDIS_URL, 'worker');
    const worker = createEventWorker({
      connection: workerRedis,
      registry: eventHandlers(logger, createStorefrontPublisher(database, storefrontRedis, logger)),
      concurrency: config.EVENT_CONCURRENCY,
      logger,
    });
    closers.push(async () => {
      await worker.close();
      workerRedis.disconnect();
      storefrontRedis.disconnect();
    });
  }

  logger.info({ roles: config.WORKER_ROLES }, 'worker started');
  return {
    async stop() {
      for (const close of closers.reverse()) await close();
      await queue.close();
      queueRedis.disconnect();
      await database.close();
    },
  };
}
