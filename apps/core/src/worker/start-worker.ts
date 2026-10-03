import { PublicSite, StorefrontSite } from '@hatti/api';
import { BillingService, MessageWallet } from '@hatti/billing/public';
import {
  CollectionService,
  MediaProcessing,
  ProductService,
  VariantService,
} from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import {
  BullMqEventPublisher,
  EventHandlerRegistry,
  OutboxRelay,
  createEventQueue,
  createEventWorker,
  createRedis,
} from '@hatti/events';
import { ImageFetcher } from '@hatti/images';
import { LowStockService, StockService } from '@hatti/inventory/public';
import type { Logger } from '@hatti/logger';
import {
  ConversionsService,
  MetaConversionsClient,
  MetaConversionsService,
} from '@hatti/marketing/public';
import { MessagesService } from '@hatti/messaging/public';
import { CourierAccountService, CourierBookingService } from '@hatti/logistics/public';
import { CustomerAnswers, FulfillmentService } from '@hatti/orders/public';
import type { WorkerConfig } from '../config.js';
import { couriersOf } from '../couriers.js';
import { messageProvidersOf } from '../messaging.js';
import { CloudflareCache, NO_EDGE_CACHE, type EdgeCache } from '../storefront/edge-cache.js';
import {
  PUBLISHED_EVENTS,
  createStorefrontPublisher,
  type StorefrontPublisher,
} from '../storefront/publisher.js';
import { workerStorage } from '../storage.js';
import { BillingNotices } from './billing-notices.js';
import { BillingRenewals } from './billing-renewals.js';
import { ConfirmationReminders } from './confirmation-reminders.js';
import { ConversionMoments, ConversionsSender, workerConversionOrders } from './conversions.js';
import { CourierBookings } from './courier-bookings.js';
import { CustomerErasures, workerCustomerData } from './customer-erasures.js';
import { ErasedReceipts } from './erased-receipts.js';
import { HandleRedirects } from './handle-redirects.js';
import { LowStockAlerts } from './low-stock-alerts.js';
import { ParcelSteps } from './parcel-steps.js';
import { MessagesSender, OrderNotifications } from './notifications.js';
import { ProductImages } from './product-images.js';
import { RiskRescoring } from './risk-rescoring.js';
import { UnpaidOrders } from './unpaid-orders.js';
import { UnreachableOrders, workerOrders } from './unreachable-orders.js';

export interface RunningWorker {
  stop(): Promise<void>;
}

/** The event consumers a worker runs; each reads the events it names. */
export interface EventConsumers {
  storefront?: StorefrontPublisher;
  redirects?: HandleRedirects;
  rescoring?: RiskRescoring;
  receipts?: ErasedReceipts;
  conversions?: ConversionMoments;
  notifications?: OrderNotifications;
  lowStock?: LowStockAlerts;
  parcelSteps?: ParcelSteps;
  billing?: BillingNotices;
}

/** Event consumers. Modules add theirs here as they gain them (search indexing, webhooks, …). */
export function eventHandlers(
  logger: Logger,
  {
    storefront,
    redirects,
    rescoring,
    receipts,
    conversions,
    notifications,
    lowStock,
    parcelSteps,
    billing,
  }: EventConsumers = {},
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
  if (receipts) {
    for (const type of ErasedReceipts.EVENTS) registry.on(type, (event) => receipts.handle(event));
  }
  if (conversions) {
    for (const type of ConversionMoments.EVENTS) {
      registry.on(type, (event) => conversions.handle(event));
    }
  }
  if (notifications) {
    for (const type of OrderNotifications.EVENTS) {
      registry.on(type, (event) => notifications.handle(event));
    }
  }
  if (lowStock) {
    for (const type of LowStockAlerts.EVENTS) registry.on(type, (event) => lowStock.handle(event));
  }
  if (parcelSteps) {
    for (const type of ParcelSteps.EVENTS) registry.on(type, (event) => parcelSteps.handle(event));
  }
  if (billing) {
    for (const type of BillingNotices.EVENTS) registry.on(type, (event) => billing.handle(event));
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
    const publisher = createStorefrontPublisher(
      database,
      storefrontRedis,
      logger,
      edgeCacheOf(config),
      new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
    );
    const redirects = new HandleRedirects(
      database,
      { products: new ProductService(database), collections: new CollectionService(database) },
      logger,
    );
    const worker = createEventWorker({
      connection: workerRedis,
      registry: eventHandlers(logger, {
        storefront: publisher,
        redirects,
        rescoring: new RiskRescoring(workerOrders(database)),
        receipts: new ErasedReceipts(workerStorage(config), logger),
        conversions: new ConversionMoments(
          new ConversionsService(database),
          workerConversionOrders(database),
        ),
        notifications: new OrderNotifications(
          database,
          new MessagesService(database),
          new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
          new CustomerAnswers(database, workerOrders(database)),
        ),
        lowStock: new LowStockAlerts(
          database,
          new LowStockService(database, new VariantService(database)),
          new MessagesService(database),
        ),
        parcelSteps: new ParcelSteps(new FulfillmentService(database, new StockService()), logger),
        billing: new BillingNotices(database, new MessagesService(database)),
      }),
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
    // Customers who have not answered asked once more to confirm (ADR-175).
    const asking = new ConfirmationReminders(database, workerOrders(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => asking.stop());
    // Orders never paid cancelled, in the days each shop allows (ADR-168).
    const unpaid = new UnpaidOrders(database, workerOrders(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => unpaid.stop());
    const erasures = new CustomerErasures(database, workerCustomerData(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => erasures.stop());
    // Products' images made ready, and those of media gone removed (ADR-158).
    const images = new ProductImages({
      processing: new MediaProcessing(database),
      storage: workerStorage(config),
      fetcher: new ImageFetcher(),
      edge: edgeCacheOf(config),
      logger,
    }).start(config.IMAGES_INTERVAL_MS);
    closers.push(() => images.stop());
    const renewals = new BillingRenewals(
      new BillingService(database, new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000')),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => renewals.stop());
    if (config.ENCRYPTION_KEYS) {
      const conversions = new ConversionsSender({
        database,
        conversions: new ConversionsService(database),
        meta: new MetaConversionsService(database, config.ENCRYPTION_KEYS),
        orders: workerConversionOrders(database),
        client: new MetaConversionsClient({
          baseUrl: config.META_GRAPH_URL,
          version: config.META_GRAPH_VERSION,
        }),
        storefronts: new StorefrontSite(config.STOREFRONT_URL ?? 'http://localhost:4100'),
        logger,
      }).start(config.CONVERSIONS_INTERVAL_MS);
      closers.push(() => conversions.stop());
      const couriers = couriersOf({
        production: config.NODE_ENV === 'production',
        postexUrl: config.POSTEX_URL,
        leopardsUrl: config.LEOPARDS_URL,
      });
      const bookings = new CourierBookings({
        database,
        bookings: new CourierBookingService(database, couriers),
        accounts: new CourierAccountService(database, config.ENCRYPTION_KEYS, couriers),
        couriers,
        fulfillments: new FulfillmentService(database, new StockService()),
        logger,
      }).start(config.COURIER_BOOKINGS_INTERVAL_MS);
      closers.push(() => bookings.stop());
    } else {
      logger.warn(
        'ENCRYPTION_KEYS is not set: no conversions go to the ad platforms, and no orders are ' +
          'booked with couriers',
      );
    }
    // Each message is paid for from its shop's credit as it goes (ADR-155).
    const wallet = new MessageWallet(database);
    const messages = new MessagesSender({
      messages: new MessagesService(database, wallet),
      providers: messageProvidersOf(config, logger),
      charges: wallet,
      logger,
    }).start(config.MESSAGES_INTERVAL_MS);
    closers.push(() => messages.stop());
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

/** Cloudflare's cache, in front of storefronts and images, where it is set up; else none. */
function edgeCacheOf(config: WorkerConfig): EdgeCache {
  return config.CLOUDFLARE_ZONE_ID && config.CLOUDFLARE_API_TOKEN
    ? new CloudflareCache({ zoneId: config.CLOUDFLARE_ZONE_ID, token: config.CLOUDFLARE_API_TOKEN })
    : NO_EDGE_CACHE;
}
