import {
  PublicSite,
  RequestLoaders,
  ScopesGuard,
  StorefrontSite,
  type ApiContext,
} from '@hatti/api';
import { CatalogModule } from '@hatti/catalog/public';
import { CheckoutModule } from '@hatti/checkout/public';
import { CustomersModule } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { IdentityModule, type IdentityServiceOptions } from '@hatti/identity/public';
import { InventoryModule } from '@hatti/inventory/public';
import { OnlineStoreModule } from '@hatti/online-store/public';
import { OrdersModule } from '@hatti/orders/public';
import type { Logger } from '@hatti/logger';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver, type MercuriusDriverConfig } from '@nestjs/mercurius';
import type { FastifyRequest } from 'fastify';
import { GraphQLError } from 'graphql';
import type { Redis } from 'ioredis';
import mercurius from 'mercurius';
import { ADMIN_GRAPHQL_PATH, LOGGER, REDIS } from './constants.js';
import { HealthController } from './health.controller.js';
import { AuditResolver } from './audit.resolver.js';
import { ShopResolver } from './shop.resolver.js';

export interface ApiModuleOptions {
  database: Database;
  /** Staff sign-in (/auth/*). */
  identity: IdentityServiceOptions;
  logger: Logger;
  redis?: Redis | null;
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
          useValue: new StorefrontSite(options.storefrontUrl ?? 'http://localhost:4100'),
        },
      ],
      exports: [Database, LOGGER, REDIS, PublicSite, StorefrontSite],
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
    return mercurius.defaultErrorFormatter({ ...execution, errors }, context);
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
        }),
        IdentityModule.forRoot(options.identity),
        CatalogModule,
        InventoryModule,
        CustomersModule,
        OrdersModule,
        OnlineStoreModule,
        CheckoutModule,
      ],
      controllers: [HealthController],
      providers: [ShopResolver, AuditResolver, { provide: APP_GUARD, useClass: ScopesGuard }],
    };
  }
}
