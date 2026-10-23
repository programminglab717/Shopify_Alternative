import { AiGateway } from '@hatti/ai';
import {
  DnsLookup,
  PublicSite,
  RequestLoaders,
  ScopesGuard,
  StorefrontSite,
  SystemDnsLookup,
  type ApiContext,
} from '@hatti/api';
import { AppsModule } from '@hatti/apps/public';
import {
  BillingModule,
  type HattiBankAccount,
  type HattiGateway,
  type HattiTax,
  type SupportContact,
} from '@hatti/billing/public';
import { CatalogModule, CopiedVariantStock } from '@hatti/catalog/public';
import { CheckoutModule } from '@hatti/checkout/public';
import { SecretBox } from '@hatti/crypto';
import { CustomersModule } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { FilesModule } from '@hatti/files/public';
import { TrustModule } from '@hatti/trust/public';
import { IdentityModule, type IdentityServiceOptions } from '@hatti/identity/public';
import { InventoryCopiedVariantStock, InventoryModule } from '@hatti/inventory/public';
import { type Couriers, LogisticsModule } from '@hatti/logistics/public';
import {
  MarketingModule,
  type MetaGraphOptions,
  type GoogleAdsOptions,
  type TikTokApiOptions,
} from '@hatti/marketing/public';
import {
  MessagingModule,
  type SupportLineSettings,
  type VoiceWebhookSettings,
  type VapidKeys,
  type WhatsAppReplySettings,
  type WhatsAppSignupSettings,
  type WhatsAppWebhookSettings,
} from '@hatti/messaging/public';
import { OnlineStoreModule } from '@hatti/online-store/public';
import { MapTiles, OrdersModule } from '@hatti/orders/public';
import { type PaymentGateways, PaymentsModule } from '@hatti/payments/public';
import { PricingModule } from '@hatti/pricing/public';
import { TaxModule } from '@hatti/tax/public';
import type { Logger } from '@hatti/logger';
import { ObjectStorage } from '@hatti/storage';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver, type MercuriusDriverConfig } from '@nestjs/mercurius';
import type { FastifyRequest } from 'fastify';
import { GraphQLError } from 'graphql';
import type { Redis } from 'ioredis';
import mercurius from 'mercurius';
import { ADMIN_GRAPHQL_PATH, LOGGER, REDIS } from './constants.js';
import { queryCostHooks, type QueryCostOptions } from './query-cost.js';
import { HealthController } from './health.controller.js';
import { StockWatchController } from './stock-watches.controller.js';
import { ActivityResolver, EventActorInterceptor } from './activity.resolver.js';
import { AuditResolver } from './audit.resolver.js';
import { HomeResolver } from './home.resolver.js';
import { StarterKitService } from './starter-kits.js';
import { StarterKitsResolver } from './starter-kits.resolver.js';
import { StoreBuilderService } from './store-builder.js';
import { StoreBuilderResolver } from './store-builder.resolver.js';
import { PayoutsResolver } from './payouts.resolver.js';
import { StoreSearchesResolver } from './store-searches.resolver.js';
import { StoreSpeedResolver } from './store-speed.resolver.js';
import { StorefrontSessionsResolver } from './storefront-sessions.resolver.js';
import { SetupChecklistService } from './setup-checklist.js';
import { SetupResolver } from './setup.resolver.js';
import { OrderAgreementResolver } from './order-agreement.resolver.js';
import { FileUsesResolver } from './file-uses.resolver.js';
import { PaymentLinkOrdersResolver } from './payment-link-orders.resolver.js';
import { DeskDutyResolver } from './desk-duty.resolver.js';
import { OrderAssignmentResolver } from './order-assignment.resolver.js';
import { ParcelHandOverResolver } from './parcel-hand-over.resolver.js';
import { OrderEventResolver } from './order-event.resolver.js';
import { InventoryFileResolver } from './inventory-file.resolver.js';
import { BroadcastEstimateResolver } from './broadcast-estimate.resolver.js';
import { ProductsExportResolver } from './products-export.resolver.js';
import { ProductsImportResolver } from './products-import.resolver.js';
import { RedirectsFromShopifyResolver } from './redirects-from-shopify.resolver.js';
import { ShopifyStores } from './shopify-stores.js';
import { ShopResolver } from './shop.resolver.js';
import { StaffResolver } from './staff.resolver.js';
import {
  CustomRoleResolver,
  StaffInvitationCustomRoleResolver,
  StaffMemberCustomRoleResolver,
} from './custom-roles.resolver.js';
import { SupportAccessResolver } from './support.resolver.js';

/** Google's own addresses for Google Ads, with no credentials: no account connects. */
const GOOGLE_ADS_DEFAULTS: GoogleAdsOptions = {
  baseUrl: 'https://googleads.googleapis.com',
  version: 'v21',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
};

export interface ApiModuleOptions {
  database: Database;
  /** Staff sign-in (/auth/*). */
  identity: IdentityServiceOptions;
  logger: Logger;
  redis?: Redis | null;
  /**
   * How queries are costed and their callers throttled (ADR-576); without it, nothing is, and
   * answers carry no `extensions.cost`.
   */
  queryCost?: QueryCostOptions | null;
  /** Show GraphiQL at /graphiql. */
  graphiql?: boolean;
  /** Replace unexpected error messages with "Internal error". On in production. */
  maskInternalErrors?: boolean;
  /**
   * Where customers reach this API's public pages, such as draft orders' links;
   * http://localhost:4000 unless given.
   */
  publicUrl?: string;
  /**
   * Where storefronts answer, each at its shop's handle's subdomain; http://localhost:4100
   * unless given.
   */
  storefrontUrl?: string;
  /** Where shops point their own domains; shops.{storefrontUrl's host} unless given. */
  storefrontDnsTarget?: string;
  /** WhatsApp's webhook (ADR-146); without it, /webhooks/whatsapp answers 404. */
  whatsapp?: WhatsAppWebhookSettings | null;
  /**
   * Hatti's Meta app and Embedded Signup's configuration (ADR-419); without them, shops cannot
   * connect WhatsApp numbers of their own.
   */
  whatsAppSignup?: WhatsAppSignupSettings | null;
  /**
   * Meta's Graph API and Hatti's shared number, as the inbox answers customers (ADR-546); without
   * them, replies are refused.
   */
  whatsAppReplies?: WhatsAppReplySettings | null;
  /**
   * Meta's Graph API, which shops' ad accounts are checked on and their spend pulled from
   * (ADR-564); https://graph.facebook.com at v26.0 unless given.
   */
  metaGraph?: MetaGraphOptions;
  /**
   * TikTok's Business API, which shops' advertiser accounts are checked on and their spend pulled
   * from (ADR-566); https://business-api.tiktok.com unless given.
   */
  tiktokApi?: TikTokApiOptions;
  /**
   * The Google Ads API and Google's OAuth, which shops' Google Ads accounts are granted through
   * and their spend pulled from (ADR-678); Google's, with no credentials, unless given.
   */
  googleAds?: GoogleAdsOptions;
  /** Hatti's VAPID keys (ADR-506); without them, nothing is pushed to staff's browsers. */
  push?: VapidKeys | null;
  /** Asks DNS whether shops' own domains point at the platform; the system's resolvers unless given. */
  dnsLookup?: DnsLookup;
  /** Where files are kept (ADR-079): R2 in production, a directory in development. */
  storage: ObjectStorage;
  /** The AI gateway (ADR-463), where configured; without it, nothing is drafted with AI. */
  ai?: AiGateway | null;
  /** The tiles of checkout's map to move the pin on (ADR-719), where configured; without them, no map. */
  mapTiles?: MapTiles | null;
  /** The couriers shops connect accounts with and book through (ADR-149); PostEx unless given. */
  couriers?: Couriers;
  /**
   * The payment gateways shops connect accounts with and take payments online through (ADR-151);
   * Safepay unless given.
   */
  paymentGateways?: PaymentGateways;
  /**
   * Hatti's own gateway account, which shops pay their plans through (ADR-154); without it,
   * invoices are not paid online.
   */
  billingGateway?: HattiGateway | null;
  /**
   * Hatti's own bank account, which shops pay invoices into by transfer or Raast (ADR-254);
   * without it, invoices are not paid by transfer.
   */
  billingBankAccount?: HattiBankAccount | null;
  /** Hatti's registration for sales tax on services (ADR-512); without it, invoices carry none. */
  billingTax?: HattiTax | null;
  /** Hatti's own support lines (ADR-508); without them, shops send requests alone. */
  support?: SupportContact | null;
  /**
   * Hatti's support WhatsApp number (ADR-560); without it, nothing written to WhatsApp is kept as
   * a support request.
   */
  supportLine?: SupportLineSettings | null;
  /** The voice gateway's webhook (ADR-611); without it, /webhooks/voice answers 404. */
  voice?: VoiceWebhookSettings | null;
  /**
   * Where the Shopify stores owners move from are reached (ADR-749); the process's fetch, waiting
   * Shopify's own time for exports, unless given.
   */
  shopifyStores?: ShopifyStores;
}

/** Resources owned by the process entry point, shared with every module. */
@Global()
@Module({})
class InfrastructureModule {
  static forRoot(options: ApiModuleOptions): DynamicModule {
    return {
      module: InfrastructureModule,
      providers: [
        { provide: Database, useValue: options.database },
        { provide: LOGGER, useValue: options.logger },
        { provide: REDIS, useValue: options.redis ?? null },
        {
          provide: PublicSite,
          useValue: new PublicSite(options.publicUrl ?? 'http://localhost:4000'),
        },
        {
          provide: StorefrontSite,
          useValue: new StorefrontSite(options.storefrontUrl ?? 'http://localhost:4100', {
            dnsTarget: options.storefrontDnsTarget,
          }),
        },
        { provide: DnsLookup, useValue: options.dnsLookup ?? new SystemDnsLookup() },
        { provide: ObjectStorage, useValue: options.storage },
        { provide: AiGateway, useValue: options.ai ?? null },
        { provide: MapTiles, useValue: options.mapTiles ?? null },
        // The keys staff sign-in encrypts with; theme previews' links are sealed with them too.
        { provide: SecretBox, useValue: options.identity.secretBox },
        // A duplicated product's stock settings, which the catalog asks the inventory for (ADR-343).
        { provide: CopiedVariantStock, useClass: InventoryCopiedVariantStock },
      ],
      exports: [
        Database,
        LOGGER,
        REDIS,
        PublicSite,
        StorefrontSite,
        DnsLookup,
        SecretBox,
        ObjectStorage,
        AiGateway,
        MapTiles,
        CopiedVariantStock,
      ],
    };
  }
}

/**
 * Errors that resolvers raise on purpose carry an `extensions.code`, and a request the server
 * cannot read, such as a body that is not JSON, is the client's to fix: BAD_REQUEST, with the
 * status Fastify gave it. Anything else is a bug or an outage: log it in full and, in
 * production, show the client only a request id.
 */
function formatErrors(maskInternalErrors: boolean): MercuriusDriverConfig['errorFormatter'] {
  return (execution, context) => {
    const errors = execution.errors.map((error) => {
      const original = error.originalError as
        (Error & { errors?: unknown; statusCode?: unknown }) | undefined;
      const expected =
        !original || original instanceof GraphQLError || Array.isArray(original.errors);
      if (expected) return error;
      const status = original.statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return new GraphQLError(original.message, {
          originalError: original,
          extensions: { code: 'BAD_REQUEST' },
        });
      }
      const requestId = context.reply.request.id;
      context.reply.log.error({ err: original, path: error.path, requestId }, 'resolver failed');
      return new GraphQLError(maskInternalErrors ? 'Internal error' : error.message, {
        nodes: error.nodes,
        path: error.path,
        extensions: { code: 'INTERNAL_SERVER_ERROR', requestId },
      });
    });
    const formatted = mercurius.defaultErrorFormatter({ ...execution, errors }, context);
    // A query refused for its cost tells what it would have cost and what is left (ADR-576).
    const cost = context.reply.request.queryCost;
    return cost
      ? { ...formatted, response: { ...formatted.response, extensions: { cost } } }
      : formatted;
  };
}

@Module({})
export class ApiModule {
  static forRoot(options: ApiModuleOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        InfrastructureModule.forRoot(options),
        GraphQLModule.forRoot<MercuriusDriverConfig>({
          driver: MercuriusDriver,
          path: ADMIN_GRAPHQL_PATH,
          autoSchemaFile: true,
          sortSchema: true,
          graphiql: options.graphiql ?? false,
          // Deeply nested queries are the cheapest way to overload a GraphQL server.
          queryDepth: 12,
          context: (request: FastifyRequest): ApiContext => ({
            tenant: request.tenant,
            loaders: new RequestLoaders(),
          }),
          // Field resolvers check scopes too: a variant's stock needs read_inventory.
          fieldResolverEnhancers: ['guards'],
          errorFormatter: formatErrors(options.maskInternalErrors ?? true),
          ...(options.queryCost && {
            hooks: queryCostHooks(options.queryCost, options.logger),
          }),
        }),
        IdentityModule.forRoot(options.identity),
        CatalogModule,
        InventoryModule,
        CustomersModule,
        OrdersModule,
        OnlineStoreModule,
        CheckoutModule,
        PricingModule,
        LogisticsModule.forRoot({ couriers: options.couriers }),
        FilesModule,
        TaxModule,
        TrustModule,
        MarketingModule.forRoot({
          metaGraph: options.metaGraph ?? {
            baseUrl: 'https://graph.facebook.com',
            version: 'v26.0',
          },
          tiktokApi: options.tiktokApi ?? { baseUrl: 'https://business-api.tiktok.com' },
          googleAds: options.googleAds ?? GOOGLE_ADS_DEFAULTS,
        }),
        AppsModule,
        MessagingModule.forRoot({
          whatsapp: options.whatsapp ?? null,
          signup: options.whatsAppSignup ?? null,
          push: options.push ?? null,
          replies: options.whatsAppReplies ?? null,
          supportLine: options.supportLine ?? null,
          voice: options.voice ?? null,
        }),
        PaymentsModule.forRoot({ gateways: options.paymentGateways }),
        BillingModule.forRoot({
          gateway: options.billingGateway ?? null,
          bankAccount: options.billingBankAccount ?? null,
          tax: options.billingTax ?? null,
          support: options.support ?? null,
        }),
      ],
      controllers: [HealthController, StockWatchController],
      providers: [
        ShopResolver,
        AuditResolver,
        ActivityResolver,
        StaffResolver,
        CustomRoleResolver,
        StaffMemberCustomRoleResolver,
        StaffInvitationCustomRoleResolver,
        SupportAccessResolver,
        OrderAgreementResolver,
        FileUsesResolver,
        PaymentLinkOrdersResolver,
        OrderAssignmentResolver,
        DeskDutyResolver,
        ParcelHandOverResolver,
        OrderEventResolver,
        ProductsImportResolver,
        RedirectsFromShopifyResolver,
        { provide: ShopifyStores, useValue: options.shopifyStores ?? new ShopifyStores() },
        ProductsExportResolver,
        BroadcastEstimateResolver,
        InventoryFileResolver,
        HomeResolver,
        StorefrontSessionsResolver,
        PayoutsResolver,
        StoreSearchesResolver,
        StoreSpeedResolver,
        StarterKitService,
        StarterKitsResolver,
        StoreBuilderService,
        StoreBuilderResolver,
        SetupChecklistService,
        SetupResolver,
        { provide: APP_GUARD, useClass: ScopesGuard },
        // What a request records carries its caller, for the shop's activity log (ADR-256).
        { provide: APP_INTERCEPTOR, useClass: EventActorInterceptor },
      ],
    };
  }
}
