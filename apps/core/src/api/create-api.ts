import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AccessTokenAuthenticator } from '@hatti/api';
import { StaffAccessResolver } from '@hatti/identity/public';
import { MessagesService } from '@hatti/messaging/public';
import { DRAFT_LINK_PATH, ORDER_LINK_PATH, RECEIPT_LIMITS } from '@hatti/orders/public';
import { LocalStorage } from '@hatti/storage';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { NestLogger } from '../logging.js';
import { ApiModule, type ApiModuleOptions } from './api.module.js';
import { adminApiAuthentication, storefrontApiAuthentication } from './auth.js';
import { keepRawBodies, readFileForms } from './forms.js';
import { IdempotencyStore, idempotencyHooks } from './idempotency.js';
import { serveImages } from './images.js';
import { serveVideos } from './videos.js';
import { serveLocalStorage } from './local-storage.js';
import { serveArticleImages } from './article-images.js';
import { serveLogos } from './logos.js';
import { serveSharingImages } from './sharing-images.js';
import { serveThemeImages } from './theme-images.js';
import { recentAuthenticationHook } from './recent-authentication.js';
import { supportAccessHook } from './support-access.js';

export interface CreateApiOptions extends ApiModuleOptions {
  trustProxy?: boolean;
  /** The key storefronts present to the /storefront/ routes; without it they are not served. */
  storefrontKey?: string;
  /** Where local storage's files are served, when files are kept in a directory: /storage. */
  localStoragePath?: string;
}

/**
 * `options`, SES's notifications telling messaging what became of the emails it sent for shops,
 * as they tell identity of addresses to send no more (ADR-197).
 */
function hearingEmailEvents(options: CreateApiOptions): CreateApiOptions {
  const emails = options.identity.emails;
  if (!emails?.feedback) return options;
  const messages = new MessagesService(options.database);
  return {
    ...options,
    identity: {
      ...options.identity,
      emails: {
        ...emails,
        feedback: {
          ...emails.feedback,
          onNotification: async (message) => {
            await emails.feedback?.onNotification?.(message);
            await messages.recordEmailEvent(message);
          },
        },
      },
    },
  };
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
  // Hatti's support only looks, and each look is logged before it runs (ADR-156).
  fastify.addHook('preHandler', supportAccessHook(options.database));
  // Before an Idempotency-Key is claimed, so a refused request keeps its key for the retry.
  fastify.addHook('preHandler', recentAuthenticationHook());
  const idempotency = idempotencyHooks(new IdempotencyStore(options.database));
  fastify.addHook('preHandler', idempotency.preHandler);
  fastify.addHook('onSend', idempotency.onSend);
  // Webhooks are signed over their bodies as sent (ADR-146): kept, before they are parsed.
  keepRawBodies(fastify, '/webhooks/');
  // Customers send the receipts of their transfers through their orders' pages (ADR-080).
  readFileForms(fastify, {
    paths: [`/${ORDER_LINK_PATH}/`, `/${DRAFT_LINK_PATH}/`],
    maxFileBytes: RECEIPT_LIMITS.bytes,
  });
  if (options.storage instanceof LocalStorage) {
    await serveLocalStorage(fastify, options.storage, options.localStoragePath ?? '/storage');
  }
  // Products' images, at the sizes and in the formats browsers ask for (ADR-158).
  serveImages(fastify, options.storage);
  // And their videos, a range at a time as browsers play them (ADR-258).
  serveVideos(fastify, options.storage);
  // Shops' logos, for their orders' emails (ADR-198).
  serveLogos(fastify, options.database, options.storage);
  // Published articles' images, for their storefronts' pages (ADR-213).
  serveArticleImages(fastify, options.database, options.storage);
  // Shops' social sharing images, for their pages' link previews (ADR-243).
  serveSharingImages(fastify, options.database, options.storage);
  // The pictures shops chose for their themes, for their storefronts to serve (ADR-326).
  serveThemeImages(fastify, options.database, options.storage);

  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(hearingEmailEvents(options)),
    adapter,
    {
      logger: new NestLogger(options.logger),
    },
  );
  await app.init();
  return app;
}
