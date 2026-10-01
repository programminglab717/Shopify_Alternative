import { CollectionService, ProductService } from '@hatti/catalog/public';
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
import { CloudflareCache, NO_EDGE_CACHE } from '../storefront/edge-cache.js';
import {
  PUBLISHED_EVENTS,
  createStorefrontPublisher,
  type StorefrontPublisher,
} from '../storefront/publisher.js';
import { CustomerErasures, workerCustomerData } from './customer-erasures.js';
import { HandleRedirects } from './handle-redirects.js';
import { RiskRescoring } from './risk-rescoring.js';
import { UnreachableOrders, workerOrders } from './unreachable-orders.js';

export interface RunningWorker {
  stop(): Promise<void>;
}

/** Event consumers. Modules add theirs here as they gain them (search indexing, webhooks, …). */
export function eventHandlers(
  logger: Logger,
  storefront?: StorefrontPublisher,
  redirects?: HandleRedirects,
  rescoring?: RiskRescoring,
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
  if (redirects) {
    for (const type of HandleRedirects.EVENTS)
      registry.on(type, (event) => redirects.handle(event));
  }
  if (rescoring) {
    for (const type of RiskRescoring.EVENTS) registry.on(type, (event) => rescoring.handle(event));
  }
  return registry;
}

/** Starts the outbox relay, the event consumers and the sweeps, as WORKER_ROLES says. */
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
    const edge =
      config.CLOUDFLARE_ZONE_ID && config.CLOUDFLARE_API_TOKEN
        ? new CloudflareCache({
            zoneId: config.CLOUDFLARE_ZONE_ID,
            token: config.CLOUDFLARE_API_TOKEN,
          })
        : NO_EDGE_CACHE;
    const publisher = createStorefrontPublisher(database, storefrontRedis, logger, edge);
    const redirects = new HandleRedirects(
      database,
      { products: new ProductService(database), collections: new CollectionService(database) },
      logger,
    );
    const worker = createEventWorker({
      connection: workerRedis,
      registry: eventHandlers(
        logger,
        publisher,
        redirects,
        new RiskRescoring(workerOrders(database)),
      ),
      concurrency: config.EVENT_CONCURRENCY,
      logger,
    });
    closers.push(async () => {
      await worker.close();
      workerRedis.disconnect();
      storefrontRedis.disconnect();
    });
  }

  if (config.WORKER_ROLES.includes('sweeps')) {
    const sweeps = new UnreachableOrders(database, workerOrders(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => sweeps.stop());
    const erasures = new CustomerErasures(database, workerCustomerData(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => erasures.stop());
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
