import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AccessTokenAuthenticator } from '@hatti/api';
import { StaffAccessResolver } from '@hatti/identity/public';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { NestLogger } from '../logging.js';
import { ApiModule, type ApiModuleOptions } from './api.module.js';
import { adminApiAuthentication, storefrontApiAuthentication } from './auth.js';
import { IdempotencyStore, idempotencyHooks } from './idempotency.js';

export interface CreateApiOptions extends ApiModuleOptions {
  trustProxy?: boolean;
  /** The key storefronts present to the /storefront/ routes; without it they are not served. */
  storefrontKey?: string;
}

/** Accept a caller's request id if it looks sane, so logs join up across services. */
function requestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && /^[\w.:-]{1,128}$/.test(header) ? header : randomUUID();
}

/**
 * Builds the API application, initialised but not listening: the Admin API, customers' pages,
 * and the routes storefronts reach.
 */
export async function createApi(options: CreateApiOptions): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    loggerInstance: options.logger,
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (request: IncomingMessage) => requestId(request.headers['x-request-id']),
  });
  const fastify = adapter.getInstance();
  fastify.addHook(
    'onRequest',
    adminApiAuthentication(
      new AccessTokenAuthenticator(options.database.app),
      new StaffAccessResolver(options.database.app),
    ),
  );
  fastify.addHook('onRequest', storefrontApiAuthentication(options.storefrontKey));
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  const idempotency = idempotencyHooks(new IdempotencyStore(options.database));
  fastify.addHook('preHandler', idempotency.preHandler);
  fastify.addHook('onSend', idempotency.onSend);

  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(options),
    adapter,
    {
      logger: new NestLogger(options.logger),
    },
  );
  await app.init();
  return app;
}
