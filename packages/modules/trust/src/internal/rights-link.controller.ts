import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { rightsPage } from './rights-page.js';
import { RIGHTS_LINK_PATH, RightsComplaintsService } from './rights.service.js';

/**
 * Sent with every response: the address carries the link's secret, so the page is never cached,
 * indexed or framed, and browsers send its address to no other site.
 */
const PRIVATE_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * Where the notice of listings taken down for a rights complaint links to (ADR-476):
 * /rights/<token> on the core's own address. Its page shows the complaint, takes the store
 * owner's counter-notice, and shows Hatti's answer.
 */
@Controller(RIGHTS_LINK_PATH)
export class RightsLinkController {
  constructor(private readonly rights: RightsComplaintsService) {}

  @Get(':token')
  async open(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    await send(reply, rightsPage(await this.rights.view(token)));
  }

  @Post(':token')
  async counter(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : '');
    const typed = {
      words: text('words'),
      signature: text('signature'),
      sworn: text('sworn') !== '',
    };
    const result = await this.rights.counter(token, typed);
    if (!result) return send(reply, rightsPage(null));
    await send(
      reply,
      result.ok
        ? rightsPage(result.view, { sent: true })
        : rightsPage(result.view, { problem: result.problem, typed }),
    );
  }
}

async function send(
  reply: FastifyReply,
  page: { status: number; html: string; contentSecurityPolicy: string },
): Promise<void> {
  await reply
    .code(page.status)
    .headers(PRIVATE_PAGE_HEADERS)
    .header('content-security-policy', page.contentSecurityPolicy)
    .header('content-type', 'text/html; charset=utf-8')
    .send(page.html);
}
