import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { legalDocument } from '@hatti/legal';
import type { RenderedPage } from '@hatti/documents';
import { legalIndexPage, legalJson, legalPage } from './legal-page.js';

/** Kept by browsers and the edge for five minutes: the documents change only with a release. */
const CACHE_CONTROL = 'public, max-age=300';

/**
 * Hatti's legal documents, on the core's own address (ADR-736): /legal, /legal/{handle}, and
 * /legal.json with each one's version.
 */
@Controller()
export class LegalController {
  @Get('legal')
  async index(@Res() reply: FastifyReply): Promise<void> {
    await send(reply, 200, legalIndexPage());
  }

  @Get('legal.json')
  @Header('cache-control', CACHE_CONTROL)
  @Header('access-control-allow-origin', '*')
  json(): object {
    return legalJson();
  }

  @Get('legal/:handle')
  async page(@Param('handle') handle: string, @Res() reply: FastifyReply): Promise<void> {
    const document = legalDocument(handle);
    await send(reply, document ? 200 : 404, document ? legalPage(document) : legalIndexPage(true));
  }
}

async function send(reply: FastifyReply, status: number, page: RenderedPage): Promise<void> {
  await reply
    .code(status)
    .header('cache-control', CACHE_CONTROL)
    .header('content-security-policy', page.contentSecurityPolicy)
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY')
    .header('content-type', 'text/html; charset=utf-8')
    .send(page.html);
}
