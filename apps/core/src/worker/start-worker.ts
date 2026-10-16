import { PublicSite, StorefrontSite, SystemDnsLookup } from '@hatti/api';
import { HttpWebhookSender, WebhookService } from '@hatti/apps/public';
import { BillingService, MessageWallet } from '@hatti/billing/public';
import {
  CollectionService,
  MediaProcessing,
  PriceSaleService,
  ProductService,
  VariantService,
} from '@hatti/catalog/public';
import { AbandonedCheckoutService, CheckoutExpiry } from '@hatti/checkout/public';
import {
  CustomerService,
  SegmentFieldRegistry,
  SegmentService,
  StoreCreditService,
} from '@hatti/customers/public';
import type { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import {
  BullMqEventPublisher,
  EventHandlerRegistry,
  OutboxRelay,
  createEventQueue,
  createEventWorker,
  createRedis,
} from '@hatti/events';
import { StoreExportService } from '@hatti/files/public';
import { ImageFetcher } from '@hatti/images';
import { InventoryService, LowStockService, StockService } from '@hatti/inventory/public';
import type { Logger } from '@hatti/logger';
import {
  ConversionsService,
  MetaConversionsClient,
  MetaConversionsService,
} from '@hatti/marketing/public';
import {
  AutomationsService,
  BroadcastsService,
  MessagesService,
  StockWatchService,
  WhatsAppAccountsService,
  WhatsAppTemplatesService,
} from '@hatti/messaging/public';
import {
  CourierAccountService,
  CourierBookingService,
  CourierCityService,
  RateCardService,
} from '@hatti/logistics/public';
import {
  ArticleService,
  DomainService,
  LinkTapsService,
  PageService,
  SessionDaysService,
} from '@hatti/online-store/public';
import {
  CustomerAnswers,
  ExportScheduleService,
  FulfillmentService,
  ORDER_SEGMENT_FACTS,
  OrderExportService,
} from '@hatti/orders/public';
import { GatewayAccountService, OnlinePaymentService } from '@hatti/payments/public';
import { StorefrontActivity } from '@hatti/storefront-data';
import type { WorkerConfig } from '../config.js';
import { couriersOf } from '../couriers.js';
import { exportEmailsOf } from '../emails.js';
import { messageProvidersOf, shopNumbersOf } from '../messaging.js';
import { paymentGatewaysOf } from '../payments.js';
import { CloudflareCache, NO_EDGE_CACHE, type EdgeCache } from '../storefront/edge-cache.js';
import {
  PUBLISHED_EVENTS,
  createStorefrontPublisher,
  type StorefrontPublisher,
} from '../storefront/publisher.js';
import { workerStorage } from '../storage.js';
import { storeExportBuilder } from '../store-export.js';
import { BillingNotices } from './billing-notices.js';
import { BillingRenewals } from './billing-renewals.js';
import { AutomationTriggers, WinBacks } from './automations.js';
import { BroadcastQueue } from './broadcasts.js';
import { CheckoutReminders } from './checkout-reminders.js';
import { ReviewRequests } from './review-requests.js';
import { WebhookDeliveries, WebhookFanOut } from './webhooks.js';
import { ConfirmationReminders } from './confirmation-reminders.js';
import { ConversionMoments, ConversionsSender, workerConversionOrders } from './conversions.js';
import { CourierBookings } from './courier-bookings.js';
import { CustomerErasures, workerCustomerData } from './customer-erasures.js';
import { DailySummaries } from './daily-summaries.js';
import { DomainChecks } from './domain-checks.js';
import { DomainNotices } from './domain-notices.js';
import { StoreExportNotices } from './store-export-notices.js';
import { PlanOrders } from './plan-orders.js';
import { ExpiredCheckouts } from './expired-checkouts.js';
import { StoreCreditExpiry } from './store-credit-expiry.js';
import { StoreCreditNotices } from './store-credit-notices.js';
import { ErasedReceipts } from './erased-receipts.js';
import { HandleRedirects } from './handle-redirects.js';
import { LowStockAlerts } from './low-stock-alerts.js';
import { BackInStockAlerts } from './back-in-stock.js';
import { CodPrepaidOffers } from './cod-prepaid-offers.js';
import { ParcelSteps } from './parcel-steps.js';
import { PaymentInquiries } from './payment-inquiries.js';
import { MessagesSender, OrderNotifications } from './notifications.js';
import { ProductImages } from './product-images.js';
import { RiskRescoring } from './risk-rescoring.js';
import { ScheduledContent, scheduledKinds } from './scheduled-content.js';
import { ScheduledExports } from './scheduled-exports.js';
import { StoreExports } from './store-exports.js';
import { StaffAlerts } from './staff-alerts.js';
import { StorefrontSessions } from './storefront-sessions.js';
import { StorefrontSweep } from './storefront-sweep.js';
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
  backInStock?: BackInStockAlerts;
  codPrepaid?: CodPrepaidOffers;
  parcelSteps?: ParcelSteps;
  billing?: BillingNotices;
  staff?: StaffAlerts;
  storeCredit?: StoreCreditNotices;
  domains?: DomainNotices;
  storeExports?: StoreExportNotices;
  planOrders?: PlanOrders;
  webhooks?: WebhookFanOut;
  automations?: AutomationTriggers;
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
    backInStock,
    codPrepaid,
    parcelSteps,
    billing,
    staff,
    storeCredit,
    domains,
    storeExports,
    planOrders,
    webhooks,
    automations,
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
  if (backInStock) {
    for (const type of BackInStockAlerts.EVENTS) {
      registry.on(type, async (event) => {
        await backInStock.handle(event);
      });
    }
  }
  if (codPrepaid) {
    for (const type of CodPrepaidOffers.EVENTS) {
      registry.on(type, async (event) => {
        await codPrepaid.handle(event);
      });
    }
  }
  if (parcelSteps) {
    for (const type of ParcelSteps.EVENTS) registry.on(type, (event) => parcelSteps.handle(event));
  }
  if (billing) {
    for (const type of BillingNotices.EVENTS) registry.on(type, (event) => billing.handle(event));
  }
  if (staff) {
    for (const type of StaffAlerts.EVENTS) registry.on(type, (event) => staff.handle(event));
  }
  if (storeCredit) {
    for (const type of StoreCreditNotices.EVENTS) {
      registry.on(type, (event) => storeCredit.handle(event));
    }
  }
  if (domains) {
    for (const type of DomainNotices.EVENTS) registry.on(type, (event) => domains.handle(event));
  }
  if (storeExports) {
    for (const type of StoreExportNotices.EVENTS) {
      registry.on(type, (event) => storeExports.handle(event));
    }
  }
  if (planOrders) {
    for (const type of PlanOrders.EVENTS) registry.on(type, (event) => planOrders.handle(event));
  }
  if (webhooks) {
    for (const type of WebhookFanOut.EVENTS) registry.on(type, (event) => webhooks.handle(event));
  }
  if (automations) {
    for (const type of AutomationTriggers.EVENTS) {
      registry.on(type, (event) => automations.handle(event));
    }
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
        backInStock: new BackInStockAlerts(
          database,
          new StockWatchService(database, new MessagesService(database)),
          new InventoryService(database, new VariantService(database)),
          new VariantService(database),
          new ProductService(database),
          new StorefrontSite(config.STOREFRONT_URL ?? 'http://localhost:4100'),
        ),
        parcelSteps: new ParcelSteps(new FulfillmentService(database, new StockService()), logger),
        billing: new BillingNotices(database, new MessagesService(database)),
        staff: new StaffAlerts(database, new MessagesService(database)),
        storeCredit: new StoreCreditNotices(database, new MessagesService(database)),
        domains: new DomainNotices(database, new MessagesService(database)),
        storeExports: new StoreExportNotices(database, new MessagesService(database)),
        planOrders: new PlanOrders(database, new MessagesService(database), workerOrders(database)),
        // Apps' webhooks need their secrets opened to be sent (ADR-397).
        ...(config.ENCRYPTION_KEYS && {
          webhooks: new WebhookFanOut(new WebhookService(database, config.ENCRYPTION_KEYS)),
          // The shop's automations, sent from its own number, whose token is sealed (ADR-425).
          automations: new AutomationTriggers(
            workerAutomations(database, config.ENCRYPTION_KEYS),
            new CustomerService(database),
          ),
          // COD to prepaid offers credit only where the shop's gateways take payments (ADR-432).
          codPrepaid: new CodPrepaidOffers(
            database,
            new MessagesService(database),
            workerOnlinePayments(database, config, config.ENCRYPTION_KEYS),
            new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
          ),
        }),
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
    // Customers' store credit that expired, written into its ledger (ADR-184), and that expires
    // within the week, for its customers to be reminded of (ADR-192).
    const credit = new StoreCreditExpiry(new StoreCreditService(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => credit.stop());
    // Each shop told each morning on WhatsApp how the day before went (ADR-386).
    const summaries = new DailySummaries(database, new MessagesService(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => summaries.stop());
    // Carts, checkouts and browsers' proofs of a number past their time deleted (ADR-230).
    const expired = new ExpiredCheckouts(new CheckoutExpiry(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => expired.stop());
    // Shoppers who typed their number at checkout and left reminded once, as their shop says
    // (ADR-393).
    const checkoutReminders = new CheckoutReminders(
      new AbandonedCheckoutService(
        database,
        new MessagesService(database),
        workerOrders(database),
        new StorefrontSite(config.STOREFRONT_URL ?? 'http://localhost:4100'),
        new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
      ),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => checkoutReminders.stop());
    // Customers of delivered orders asked once to rate them, as their shop says (ADR-400).
    const reviewRequests = new ReviewRequests(
      database,
      new MessagesService(database),
      new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => reviewRequests.stop());
    // Apps' webhooks posted, signed with each app's secret, and tried again for two days (ADR-397).
    if (config.ENCRYPTION_KEYS) {
      const webhookDeliveries = new WebhookDeliveries(
        new WebhookService(database, config.ENCRYPTION_KEYS),
        new HttpWebhookSender(
          config.WEBHOOK_PRIVATE_ADDRESSES
            ? { protocols: ['http:', 'https:'], allowAddress: () => true }
            : {},
        ),
        logger,
      ).start(config.WEBHOOK_INTERVAL_MS);
      closers.push(() => webhookDeliveries.stop());
    } else {
      logger.warn('ENCRYPTION_KEYS is not set: no webhooks are sent to apps');
    }
    // Shops' verified domains asked about again, and those DNS points elsewhere disconnected three
    // days on (ADR-262).
    const domainChecks = new DomainChecks(
      new DomainService(
        database,
        new StorefrontSite(config.STOREFRONT_URL ?? 'http://localhost:4100', {
          dnsTarget: config.STOREFRONT_DNS_TARGET,
        }),
        new SystemDnsLookup(),
      ),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => domainChecks.stop());
    // Articles and pages published at a time ahead shown once it comes (ADR-215, ADR-217).
    const scheduledContent = new ScheduledContent(
      scheduledKinds(
        new ArticleService(database),
        new PageService(database),
        new ProductService(database),
        new PriceSaleService(database),
      ),
      logger,
    ).start(config.SCHEDULED_INTERVAL_MS);
    closers.push(() => scheduledContent.stop());
    // Products' images made ready, and those of media gone removed (ADR-158).
    const images = new ProductImages({
      processing: new MediaProcessing(database),
      storage: workerStorage(config),
      fetcher: new ImageFetcher(),
      edge: edgeCacheOf(config),
      logger,
    }).start(config.IMAGES_INTERVAL_MS);
    closers.push(() => images.stop());
    // The storefronts' counts of each day's sessions, and of its taps on link pages' links, kept in
    // Postgres (ADR-180, ADR-204).
    const sessionsRedis = createRedis(config.REDIS_URL, 'worker');
    const sessions = new StorefrontSessions(
      new StorefrontActivity(sessionsRedis),
      { days: new SessionDaysService(database), taps: new LinkTapsService(database) },
      logger,
    ).start(config.SESSIONS_INTERVAL_MS);
    closers.push(async () => {
      await sessions.stop();
      sessionsRedis.disconnect();
    });
    // Storefronts whose publisher gave up on them, built once their shops go quiet (ADR-225).
    const sweepRedis = createRedis(config.REDIS_URL, 'worker');
    const storefronts = new StorefrontSweep(
      createStorefrontPublisher(
        database,
        sweepRedis,
        logger,
        edgeCacheOf(config),
        new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
      ),
      logger,
    ).start(config.STOREFRONTS_INTERVAL_MS);
    closers.push(async () => {
      await storefronts.stop();
      sweepRedis.disconnect();
    });
    // Exports staff scheduled, emailed as each period ends (ADR-183).
    const exportEmails = exportEmailsOf(config, logger);
    if (exportEmails) {
      const scheduled = new ScheduledExports(
        new ExportScheduleService(database, new OrderExportService(database)),
        exportEmails,
        logger,
      ).start(config.SWEEP_INTERVAL_MS);
      closers.push(() => scheduled.stop());
    } else {
      logger.warn('SES is not set up: scheduled exports wait until it is');
    }
    // The whole store, exported as its owners ask (ADR-415).
    const storeExports = new StoreExports(
      new StoreExportService(database, workerStorage(config)),
      storeExportBuilder(database, new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000')),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => storeExports.stop());
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
      const courierAccounts = new CourierAccountService(database, config.ENCRYPTION_KEYS, couriers);
      const bookings = new CourierBookings({
        database,
        bookings: new CourierBookingService(database, couriers),
        accounts: courierAccounts,
        cities: new CourierCityService(database, courierAccounts, couriers),
        couriers,
        fulfillments: new FulfillmentService(database, new StockService()),
        rateCards: new RateCardService(database),
        logger,
      }).start(config.COURIER_BOOKINGS_INTERVAL_MS);
      closers.push(() => bookings.stop());
      // Payments started online whose customers never came back, asked after (ADR-208).
      const inquiries = new PaymentInquiries(
        workerOnlinePayments(database, config, config.ENCRYPTION_KEYS),
        logger,
      ).start(config.SWEEP_INTERVAL_MS);
      closers.push(() => inquiries.stop());
      // Shops' broadcasts queued once their time comes, in marketing hours (ADR-422).
      const broadcasts = new BroadcastQueue(
        workerBroadcasts(database, config.ENCRYPTION_KEYS),
        logger,
      ).start(config.SCHEDULED_INTERVAL_MS);
      closers.push(() => broadcasts.stop());
      // Lapsed customers won back, where the shop's win-back is on (ADR-425).
      const winBacks = new WinBacks(
        workerAutomations(database, config.ENCRYPTION_KEYS),
        logger,
      ).start(config.SWEEP_INTERVAL_MS);
      closers.push(() => winBacks.stop());
    } else {
      logger.warn(
        'ENCRYPTION_KEYS is not set: no conversions go to the ad platforms, no orders are ' +
          'booked with couriers, no payments are asked after, and no broadcasts are sent',
      );
    }
    // Each message is paid for from its shop's credit as it goes (ADR-155).
    const wallet = new MessageWallet(database);
    const messages = new MessagesSender({
      messages: new MessagesService(database, wallet),
      providers: messageProvidersOf(config, logger),
      charges: wallet,
      // Broadcasts go from each shop's own number (ADR-422), whose token is sealed.
      ...(config.ENCRYPTION_KEYS && {
        shopNumbers: shopNumbersOf(
          new WhatsAppAccountsService(database, config.ENCRYPTION_KEYS, null),
          config,
        ),
      }),
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

/** Shops' broadcasts as the worker queues them (ADR-422): their templates on their own numbers. */
function workerBroadcasts(database: Database, box: SecretBox): BroadcastsService {
  return new BroadcastsService(
    database,
    workerTemplates(database, box),
    workerSegments(database),
    new MessagesService(database),
  );
}

/** Shops' automations as the worker sends them (ADR-425). */
function workerAutomations(database: Database, box: SecretBox): AutomationsService {
  return new AutomationsService(
    database,
    workerTemplates(database, box),
    workerSegments(database),
    new MessagesService(database),
  );
}

function workerTemplates(database: Database, box: SecretBox): WhatsAppTemplatesService {
  return new WhatsAppTemplatesService(database, new WhatsAppAccountsService(database, box, null));
}

/** Segments with the orders module's facts, as the API has them. */
function workerSegments(database: Database): SegmentService {
  const registry = new SegmentFieldRegistry();
  registry.register(ORDER_SEGMENT_FACTS);
  return new SegmentService(database, registry);
}

/** The shops' gateways, as the API takes payments through them (ADR-151). */
function workerOnlinePayments(
  database: Database,
  config: WorkerConfig,
  box: SecretBox,
): OnlinePaymentService {
  const gateways = paymentGatewaysOf({ production: config.NODE_ENV === 'production' });
  return new OnlinePaymentService(
    database,
    new GatewayAccountService(
      database,
      box,
      new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
      gateways,
    ),
    gateways,
  );
}

/** Cloudflare's cache, in front of storefronts and images, where it is set up; else none. */
function edgeCacheOf(config: WorkerConfig): EdgeCache {
  return config.CLOUDFLARE_ZONE_ID && config.CLOUDFLARE_API_TOKEN
    ? new CloudflareCache({ zoneId: config.CLOUDFLARE_ZONE_ID, token: config.CLOUDFLARE_API_TOKEN })
    : NO_EDGE_CACHE;
}
