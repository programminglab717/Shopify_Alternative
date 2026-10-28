import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { SupportService, type SupportWhatsAppSender } from '@hatti/billing/public';
import type { Database, Db } from '@hatti/db';
import {
  ConsoleAuthController,
  ConsoleAuthService,
  ConsoleGuard,
  type ConsoleSignInSettings,
} from '@hatti/identity/public';
import type { Logger } from '@hatti/logger';
import { Controller, Get, Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { NestLogger } from '../logging.js';
import { ConsoleController } from './console.controller.js';

export interface CreateConsoleOptions {
  /** With the system login (hatti_system), which reads every shop's. */
  database: Database;
  /** The identity login: Hatti's agents, and the console's sessions and log. */
  identityDb: Db;
  console: ConsoleSignInSettings;
  /** Answers to requests written on WhatsApp go back there (ADR-560); none without it. */
  supportSender?: SupportWhatsAppSender | null;
  logger: Logger;
  trustProxy?: boolean;
}

/** The process is up, for the console's load balancer. */
@Controller('console/api')
class ConsoleHealthController {
  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

@Module({})
class ConsoleModule {
  static forRoot(options: CreateConsoleOptions): DynamicModule {
    return {
      module: ConsoleModule,
      controllers: [ConsoleHealthController, ConsoleAuthController, ConsoleController],
      providers: [
        {
          provide: ConsoleAuthService,
          useValue: new ConsoleAuthService({ db: options.identityDb, console: options.console }),
        },
        ConsoleGuard,
        {
          provide: SupportService,
          useValue: new SupportService(options.database, null, options.supportSender ?? null),
        },
      ],
    };
  }
}

/** Accept a caller's request id if it looks sane, so logs join up across services. */
function requestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && /^[\w.:-]{1,128}$/.test(header) ? header : randomUUID();
}

/**
 * Builds the console's server (ADR-876), initialised but not listening: its sign-in through
 * Hatti's provider, and the queues of Hatti's people, at `/console/api`.
 */
export async function createConsoleApi(
  options: CreateConsoleOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    loggerInstance: options.logger,
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 256 * 1024,
    genReqId: (request: IncomingMessage) => requestId(request.headers['x-request-id']),
  });
  adapter.getInstance().addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    ConsoleModule.forRoot(options),
    adapter,
    { logger: new NestLogger(options.logger) },
  );
  await app.init();
  return app;
}
