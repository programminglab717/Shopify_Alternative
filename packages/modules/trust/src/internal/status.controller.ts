import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { IncidentsService } from './incidents.service.js';
import { statusJson, statusPage } from './status-page.js';

/**
 * Kept by the edge for half a minute, and served from it for a day if the core cannot answer
 * (ADR-498): the status page stays up when what it reports on is down.
 */
const CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=30, stale-if-error=86400';

/** Hatti's status page, on the core's own address: /status, and /status.json for monitors. */
@Controller()
export class StatusController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get('status')
  async page(@Res() reply: FastifyReply): Promise<void> {
    const page = statusPage(await this.incidents.snapshot());
    await reply
      .code(200)
      .header('cache-control', CACHE_CONTROL)
      .header('content-security-policy', page.contentSecurityPolicy)
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('content-type', 'text/html; charset=utf-8')
      .send(page.html);
  }

  @Get('status.json')
  @Header('cache-control', CACHE_CONTROL)
  @Header('access-control-allow-origin', '*')
  async json(): Promise<object> {
    return statusJson(await this.incidents.snapshot());
  }
}
