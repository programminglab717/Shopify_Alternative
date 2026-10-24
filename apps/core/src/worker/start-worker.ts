import { PublicSite, StorefrontSite, SystemDnsLookup } from '@hatti/api';
import { HttpWebhookSender, WebhookService } from '@hatti/apps/public';
import { BillingService, MessageWallet, SupportService } from '@hatti/billing/public';
import {
  CollectionService,
  MediaProcessing,
  PriceSaleService,
  ProductService,
  VariantService,
} from '@hatti/catalog/public';
import {
  AbandonedCheckoutService,
  AccountDataExpiry,
  CheckoutExpiry,
} from '@hatti/checkout/public';
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
import { ImageFetcher, VideoSizer } from '@hatti/images';
import { InventoryService, LowStockService, StockService } from '@hatti/inventory/public';
import type { Logger } from '@hatti/logger';
import {
  ConversionsService,
  GoogleAnalyticsClient,
  GoogleAnalyticsService,
  MetaAdAccountService,
  MetaAdsClient,
  MetaConversionsClient,
  MetaConversionsService,
  GoogleAdsAccountService,
  GoogleAdsClient,
  TikTokAdAccountService,
  TikTokAdsClient,
  TikTokEventsClient,
  TikTokEventsService,
} from '@hatti/marketing/public';
import {
  AutomationsService,
  BroadcastsService,
  MessageRetention,
  MessagesService,
  PushService,
  SmsSendersService,
  StockWatchService,
  WebPushSender,
  WhatsAppAccountsService,
  WhatsAppBusinessClient,
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
  CommentService,
  DomainService,
  LinkTapsService,
  PageService,
  SessionDaysService,
  ThemeService,
} from '@hatti/online-store/public';
import {
  CustomerAnswers,
  DeskDutyService,
  ExportScheduleService,
  FulfillmentService,
  ORDER_LINK_PATH,
  ORDER_SEGMENT_FACTS,
  OrderExportService,
} from '@hatti/orders/public';
import { GatewayAccountService, OnlinePaymentService } from '@hatti/payments/public';
import { StorefrontActivity } from '@hatti/storefront-data';
import { googleAdsOptions, vapidKeysOf, type WorkerConfig } from '../config.js';
import { couriersOf } from '../couriers.js';
import { exportEmailsOf, hattiEmailsOf } from '../emails.js';
import { messageProvidersOf, ownNumbersOf, shopNumbersOf } from '../messaging.js';
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
import { PartnerEarnings } from './partner-earnings.js';
import { OverdueOrderMessages } from './overdue-order-messages.js';
import { OverdueConversationPushes, OverdueOrderPushes, PushNotices } from './push-notices.js';
import { BillingRenewals } from './billing-renewals.js';
import { AutomationTriggers, WinBacks } from './automations.js';
import { BroadcastQueue } from './broadcasts.js';
import { CheckoutReminders } from './checkout-reminders.js';
import { ReviewRequests } from './review-requests.js';
import { WebhookDeliveries, WebhookFanOut } from './webhooks.js';
import { ConfirmationReminders } from './confirmation-reminders.js';
import {
  FbrDigitalInvoicingClient,
  FbrPosClient,
  FbrPosService,
  FiscalInvoicesService,
} from '@hatti/tax/public';
import { AdSpendSync } from './ad-spend-sync.js';
import { ConversionMoments, ConversionsSender, workerConversionOrders } from './conversions.js';
import { FiscalReporter } from './fiscal-reports.js';
import { CourierBookings } from './courier-bookings.js';
import { CustomerErasures, workerCustomerData } from './customer-erasures.js';
import { DailySummaries } from './daily-summaries.js';
import { DomainChecks } from './domain-checks.js';
import { DomainNotices } from './domain-notices.js';
import { StoreExportNotices } from './store-export-notices.js';
import { PlanOrders } from './plan-orders.js';
import { ExpiredCheckouts } from './expired-checkouts.js';
import { CommentAddressRetention } from './comment-retention.js';
import { MessageContentRetention } from './message-retention.js';
import { OutboxRetention } from './outbox-retention.js';
import { ClosedShopPurges } from './closed-shop-purges.js';
import { ClosedShopData } from '../closed-shops.js';
import { AccountDataFiles } from './account-data-files.js';
import { ExpiredMemberships } from './expired-memberships.js';
import { StoreCreditExpiry } from './store-credit-expiry.js';
import { StoreCreditNotices } from './store-credit-notices.js';
import { GiftCardSales } from './gift-card-sales.js';
import { CashbackRewards } from './cashback.js';
import { ErasedReceipts } from './erased-receipts.js';
import { HandleRedirects } from './handle-redirects.js';
import { LowStockAlerts } from './low-stock-alerts.js';
import { BackInStockAlerts } from './back-in-stock.js';
import { StoreOpenNotices } from './store-open.js';
import { CodPrepaidOffers } from './cod-prepaid-offers.js';
import { ParcelSteps } from './parcel-steps.js';
import { PaymentInquiries } from './payment-inquiries.js';
import { MessagesSender, OrderNotifications } from './notifications.js';
import { ProductImages } from './product-images.js';
import { VideoSizes } from './video-sizes.js';
import { RiskRescoring } from './risk-rescoring.js';
import { ScheduledContent, scheduledKinds } from './scheduled-content.js';
import { ScheduledExports } from './scheduled-exports.js';
import { StoreExports } from './store-exports.js';
import { StaffAlerts } from './staff-alerts.js';
import { SupportAlerts } from './support-alerts.js';
import { StatusMail } from './status-mail.js';
import { StatusShopNotices } from './status-shop-notices.js';
import { LegalChangeNotices } from './legal-notices.js';
import { OrderTemplates } from './order-templates.js';
import { StatusProbes } from './status-probes.js';
import { IncidentsService, StatusSubscriptionsService } from '@hatti/trust/public';
import { StorefrontSessions } from './storefront-sessions.js';
import { StorefrontSweep } from './storefront-sweep.js';
import { UnpaidOrders } from './unpaid-orders.js';
import { UnreachableOrders, workerOrders } from './unreachable-orders.js';
import { LapsedShifts } from './lapsed-shifts.js';

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
  storeOpen?: StoreOpenNotices;
  codPrepaid?: CodPrepaidOffers;
  parcelSteps?: ParcelSteps;
  billing?: BillingNotices;
  partnerEarnings?: PartnerEarnings;
  push?: PushNotices;
  staff?: StaffAlerts;
  storeCredit?: StoreCreditNotices;
  giftCards?: GiftCardSales;
  cashback?: CashbackRewards;
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
    storeOpen,
    codPrepaid,
    parcelSteps,
    billing,
    partnerEarnings,
    push,
    staff,
    storeCredit,
    giftCards,
    cashback,
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
  if (storeOpen) {
    for (const type of StoreOpenNotices.EVENTS) {
      registry.on(type, async (event) => {
        await storeOpen.handle(event);
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
  if (partnerEarnings) {
    for (const type of PartnerEarnings.EVENTS) {
      registry.on(type, (event) => partnerEarnings.handle(event));
    }
  }
  if (push) {
    for (const type of PushNotices.EVENTS) registry.on(type, (event) => push.handle(event));
  }
  if (staff) {
    for (const type of StaffAlerts.EVENTS) registry.on(type, (event) => staff.handle(event));
  }
  if (storeCredit) {
    for (const type of StoreCreditNotices.EVENTS) {
      registry.on(type, (event) => storeCredit.handle(event));
    }
  }
  if (giftCards) {
    for (const type of GiftCardSales.EVENTS) registry.on(type, (event) => giftCards.handle(event));
  }
  if (cashback) {
    for (const type of CashbackRewards.EVENTS) {
      registry.on(type, async (event) => {
        await cashback.handle(event);
      });
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
    // Events published more than seven days ago deleted, so the outbox stays a week (ADR-746).
    const outboxRetention = new OutboxRetention(database.systemDb, logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => outboxRetention.stop());
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
    const vapid = vapidKeysOf(config);
    const pushes = new PushService(database, vapid && new WebPushSender(vapid));
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
          pushes,
        ),
        backInStock: new BackInStockAlerts(
          database,
          new StockWatchService(database, new MessagesService(database)),
          new InventoryService(database, new VariantService(database)),
          new VariantService(database),
          new ProductService(database),
          new StorefrontSite(config.STOREFRONT_URL ?? 'http://localhost:4100'),
        ),
        storeOpen: new StoreOpenNotices(
          database,
          workerSegments(database),
          new MessagesService(database),
          new StorefrontSite(config.STOREFRONT_URL ?? 'http://localhost:4100'),
        ),
        parcelSteps: new ParcelSteps(new FulfillmentService(database, new StockService()), logger),
        billing: new BillingNotices(database, new MessagesService(database)),
        partnerEarnings: new PartnerEarnings(database),
        push: new PushNotices(database, pushes),
        staff: new StaffAlerts(database, new MessagesService(database), pushes),
        storeCredit: new StoreCreditNotices(database, new MessagesService(database)),
        giftCards: new GiftCardSales(database, new MessagesService(database)),
        cashback: new CashbackRewards(database),
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
    // What waits on agents whose shift at the desk ran out handed over (ADR-666).
    const lapsed = new LapsedShifts(new DeskDutyService(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => lapsed.stop());
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
    // Collaborators' memberships past their end taken away (ADR-487).
    const collaborators = new ExpiredMemberships(database.app, logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => collaborators.stop());
    // Each shop told each morning on WhatsApp how the day before went (ADR-386).
    const summaries = new DailySummaries(database, new MessagesService(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => summaries.stop());
    // Staff pushed of orders waiting past the first-call target, at most hourly (ADR-627).
    const vapid = vapidKeysOf(config);
    const overdue = new OverdueOrderPushes(
      database,
      new PushService(database, vapid && new WebPushSender(vapid)),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => overdue.stop());
    // And of customers waiting on WhatsApp past the shop's time to answer, once a wait (ADR-762).
    const waiting = new OverdueConversationPushes(
      database,
      new PushService(database, vapid && new WebPushSender(vapid)),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => waiting.stop());
    // And told at the shop's alerts number on WhatsApp, at most every three hours (ADR-680).
    const overdueMessages = new OverdueOrderMessages(
      database,
      new MessagesService(database),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => overdueMessages.stop());
    // Carts, checkouts and browsers' proofs of a number past their time deleted (ADR-230).
    const expired = new ExpiredCheckouts(new CheckoutExpiry(database), logger).start(
      config.SWEEP_INTERVAL_MS,
    );
    closers.push(() => expired.stop());
    // What messages said cleared, and what customers wrote deleted, after twelve months (ADR-738).
    const messageRetention = new MessageContentRetention(
      new MessageRetention(database),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => messageRetention.stop());
    // Comments on articles forget the address and browser they came from after 90 days (ADR-748).
    const commentAddresses = new CommentAddressRetention(
      new CommentService(database),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => commentAddresses.stop());
    // Closed shops' data deleted 90 days after they closed, but the records kept, once counsel has
    // confirmed what is kept (ADR-741).
    if (config.CLOSED_SHOP_PURGE) {
      const closedShops = new ClosedShopPurges(
        new ClosedShopData(database, workerStorage(config)),
        logger,
      ).start(config.SWEEP_INTERVAL_MS);
      closers.push(() => closedShops.stop());
    }
    // Shoppers' files of their own data let go once their day is up (ADR-572).
    const accountFiles = new AccountDataFiles(
      new AccountDataExpiry(database, workerStorage(config)),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => accountFiles.stop());
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
    // Articles, pages and themes published at a time ahead shown once it comes (ADR-215,
    // ADR-217, ADR-695).
    const scheduledContent = new ScheduledContent(
      scheduledKinds(
        new ArticleService(database),
        new PageService(database),
        new ProductService(database),
        new PriceSaleService(database),
        new ThemeService(database),
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
    // Their videos' smaller sizes, where the worker has ffmpeg (ADR-791).
    const sizer = new VideoSizer({ ffmpeg: config.FFMPEG_PATH });
    if (await sizer.available()) {
      const videoSizes = new VideoSizes({
        processing: new MediaProcessing(database),
        storage: workerStorage(config),
        sizer,
        logger,
      }).start(config.VIDEO_SIZES_INTERVAL_MS);
      closers.push(() => videoSizes.stop());
    } else {
      logger.warn(
        { ffmpeg: config.FFMPEG_PATH },
        "no ffmpeg with H.264: products' videos play as uploaded, with no smaller sizes",
      );
    }
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
    // Shops' support requests still open past their plan's time, told to Hatti's people (ADR-525).
    const supportAlerts = new SupportAlerts(
      new SupportService(database),
      hattiEmailsOf(config, logger),
      config.SUPPORT_EMAIL ?? null,
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => supportAlerts.stop());
    // The status page's emails: links to confirm, and incidents' updates (ADR-535).
    const statusMail = new StatusMail(
      new StatusSubscriptionsService(database),
      hattiEmailsOf(config, logger),
      new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => statusMail.stop());
    // Every shop told on WhatsApp when an outage begins and ends (ADR-544).
    const statusNotices = new StatusShopNotices(
      new StatusSubscriptionsService(database),
      database,
      new MessagesService(database),
      new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => statusNotices.stop());
    // Every shop open before it told of a new version of Hatti's terms and policies (ADR-742).
    const legalNotices = new LegalChangeNotices(
      database,
      new MessagesService(database),
      new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
      logger,
    ).start(config.SWEEP_INTERVAL_MS);
    closers.push(() => legalNotices.stop());
    // Hatti's parts checked, incidents posted when one stops answering (ADR-536).
    if (config.STATUS_PROBES.length > 0) {
      const probes = new StatusProbes(
        new IncidentsService(database),
        config.STATUS_PROBES,
        fetch,
        logger,
      ).start(Math.max(config.SWEEP_INTERVAL_MS, 60_000));
      closers.push(() => probes.stop());
    }
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
        tiktok: new TikTokEventsService(database, config.ENCRYPTION_KEYS),
        tiktokClient: new TikTokEventsClient({ baseUrl: config.TIKTOK_API_URL }),
        google: new GoogleAnalyticsService(database, config.ENCRYPTION_KEYS),
        googleClient: new GoogleAnalyticsClient({ baseUrl: config.GOOGLE_ANALYTICS_URL }),
        storefronts: new StorefrontSite(config.STOREFRONT_URL ?? 'http://localhost:4100'),
        logger,
      }).start(config.CONVERSIONS_INTERVAL_MS);
      closers.push(() => conversions.stop());
      // Shops' ad spend pulled from the Meta ad accounts (ADR-564), TikTok advertiser accounts
      // (ADR-566) and Google Ads accounts (ADR-678) they connected.
      const adSpend = new AdSpendSync(
        {
          meta: new MetaAdAccountService(
            database,
            config.ENCRYPTION_KEYS,
            new MetaAdsClient({
              baseUrl: config.META_GRAPH_URL,
              version: config.META_GRAPH_VERSION,
            }),
          ),
          tiktok: new TikTokAdAccountService(
            database,
            config.ENCRYPTION_KEYS,
            new TikTokAdsClient({ baseUrl: config.TIKTOK_API_URL }),
          ),
          google: new GoogleAdsAccountService(
            database,
            config.ENCRYPTION_KEYS,
            new GoogleAdsClient(googleAdsOptions(config)),
          ),
        },
        logger,
      ).start(config.AD_SPEND_SYNC_INTERVAL_MS);
      closers.push(() => adSpend.stop());
      // Shops' invoices reported to FBR from the POS each connected (ADR-555), or through
      // digital invoicing (ADR-562).
      const fiscal = new FiscalReporter({
        fiscal: new FiscalInvoicesService(database),
        pos: new FbrPosService(database, config.ENCRYPTION_KEYS),
        client: new FbrPosClient({
          productionUrl: config.FBR_POS_URL,
          sandboxUrl: config.FBR_POS_SANDBOX_URL,
        }),
        digitalInvoicing: new FbrDigitalInvoicingClient({
          productionUrl: config.FBR_DI_URL,
          sandboxUrl: config.FBR_DI_SANDBOX_URL,
        }),
        logger,
      }).start(config.FISCAL_INTERVAL_MS);
      closers.push(() => fiscal.stop());
      const couriers = couriersOf({
        production: config.NODE_ENV === 'production',
        postexUrl: config.POSTEX_URL,
        leopardsUrl: config.LEOPARDS_URL,
        tcsUrl: config.TCS_URL,
        traxUrl: config.TRAX_URL,
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
      // Shops' broadcasts queued once their time comes, in marketing hours (ADR-422), and their SMS
      // campaigns with them (ADR-458).
      const broadcasts = new BroadcastQueue(
        workerBroadcasts(
          database,
          config.ENCRYPTION_KEYS,
          new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
        ),
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
        'ENCRYPTION_KEYS is not set: no conversions go to the ad platforms, no ad spend is ' +
          'pulled from Meta, no invoices go to FBR, no orders are booked with couriers, no ' +
          'payments are asked after, and no broadcasts are sent',
      );
    }
    // Each message is paid for from its shop's credit as it goes (ADR-155).
    const wallet = new MessageWallet(database);
    const smsSenders = new SmsSendersService(database);
    const whatsAppAccounts =
      config.ENCRYPTION_KEYS && new WhatsAppAccountsService(database, config.ENCRYPTION_KEYS, null);
    const messages = new MessagesSender({
      messages: new MessagesService(database, wallet),
      providers: messageProvidersOf(config, logger, config.PUBLIC_URL),
      charges: wallet,
      // Customers' SMS go from each shop's own sender name, once approved (ADR-469).
      smsSenders: (shopId) => smsSenders.senderOf(shopId),
      // Broadcasts go from each shop's own number (ADR-422), whose token is sealed, as does its
      // customers' order news once Meta approves Hatti's templates on its account (ADR-537).
      ...(whatsAppAccounts && {
        shopNumbers: shopNumbersOf(whatsAppAccounts, config),
        ownNumbers: ownNumbersOf(
          whatsAppAccounts,
          new WhatsAppTemplatesService(database, whatsAppAccounts),
          config,
        ),
      }),
      logger,
    }).start(config.MESSAGES_INTERVAL_MS);
    closers.push(() => messages.stop());
    if (whatsAppAccounts) {
      const orderTemplates = new OrderTemplates(
        new WhatsAppTemplatesService(database, whatsAppAccounts),
        new WhatsAppBusinessClient({
          baseUrl: config.META_GRAPH_URL,
          version: config.META_GRAPH_VERSION,
        }),
        new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000').url(`/${ORDER_LINK_PATH}/`),
        logger,
      ).start(Math.max(config.SWEEP_INTERVAL_MS, 60_000));
      closers.push(() => orderTemplates.stop());
    }
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

/**
 * Shops' broadcasts as the worker queues them (ADR-422): their templates on their own numbers; and
 * their SMS campaigns, each message's link to stop on the core's own address (ADR-458).
 */
function workerBroadcasts(database: Database, box: SecretBox, site: PublicSite): BroadcastsService {
  return new BroadcastsService(
    database,
    workerTemplates(database, box),
    workerSegments(database),
    new MessagesService(database),
    site,
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
