import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { appealPage } from './appeal-page.js';
import { APPEAL_LINK_PATH, AppealsService } from './appeals.service.js';

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
 * Where the notice of a store taken down links to (ADR-462): /appeal/<token> on the core's own
 * address. Its page says why the store is down, takes the owner's side of it, and shows Hatti's
 * answers.
 */
@Controller(APPEAL_LINK_PATH)
export class AppealController {
  constructor(private readonly appeals: AppealsService) {}

  @Get(':token')
  async open(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    await send(reply, appealPage(await this.appeals.view(token)));
  }

  @Post(':token')
  async appeal(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const words = typeof fields.words === 'string' ? fields.words : '';
    const result = await this.appeals.appeal(token, words);
    if (!result) return send(reply, appealPage(null));
    await send(
      reply,
      result.ok
        ? appealPage(result.view, { sent: true })
        : appealPage(result.view, { problem: result.problem, typed: words }),
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
