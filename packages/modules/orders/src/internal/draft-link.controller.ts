import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { draftLinkPage, type DraftLinkPage } from './draft-link-page.js';
import { DRAFT_LINK_PATH, DraftOrderService } from './draft-order.service.js';

/**
 * Sent with every response: the address carries the link's secret, so the page is never cached,
 * indexed or framed, and browsers send its address to no other site, such as Google Fonts.
 */
const PRIVATE_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * The customer's side of a draft order's link, /d/<secret>: GET shows the order, POST confirms
 * it. The secret is the only credential; it is 128 random bits, and unknown ones cost one indexed
 * lookup. Only a POST changes anything, so link previews and scanners that fetch the page never
 * place an order.
 */
@Controller(DRAFT_LINK_PATH)
export class DraftLinkController {
  constructor(private readonly drafts: DraftOrderService) {}

  @Get(':token')
  async show(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    await send(reply, draftLinkPage(await this.drafts.viewLink(token)));
  }

  /**
   * Confirms the order as the page showed it, at the version in the form. Once placed, it
   * redirects to the page, so reloading does not post again.
   */
  @Post(':token')
  async confirm(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Without a version, the post is taken for one from a page that changed since.
    const view = await this.drafts.confirmLink(token, versionOf(body) ?? 0);
    if (view.kind === 'completed') {
      await reply.code(303).headers(PRIVATE_PAGE_HEADERS).header('location', token).send();
      return;
    }
    await send(reply, draftLinkPage(view));
  }
}

async function send(reply: FastifyReply, page: DraftLinkPage): Promise<void> {
  await reply
    .code(page.status)
    .headers(PRIVATE_PAGE_HEADERS)
    .header('content-security-policy', page.contentSecurityPolicy)
    .header('content-type', 'text/html; charset=utf-8')
    .send(page.html);
}

/** The draft's version the page showed, from the form. */
function versionOf(body: unknown): number | null {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).version : null;
  const version = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof version === 'number' && Number.isSafeInteger(version) ? version : null;
}
