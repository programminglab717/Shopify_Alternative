import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DraftOrderService } from './draft-order.service.js';
import { draftLinkPage, orderLinkPage, type LinkPage } from './link-pages.js';
import { DRAFT_LINK_PATH, ORDER_LINK_PATH } from './links.js';
import { OrderLinkService } from './order-link.service.js';

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
   * Confirms the order as the page showed it. Once placed, it redirects to the page, so reloading
   * does not post again.
   */
  @Post(':token')
  async confirm(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.drafts.confirmLink(token, field(body, 'shown'));
    if (view.kind === 'completed') return seeOther(reply, token);
    await send(reply, draftLinkPage(view));
  }
}

/**
 * The customer's side of an order's link, /o/<secret>: GET shows the order, and with `?cancel`
 * asks whether they mean to cancel it; POST confirms (`action=confirm`) or cancels
 * (`action=cancel`) a cash-on-delivery order that waits for them. As for drafts, only a POST
 * changes anything.
 */
@Controller(ORDER_LINK_PATH)
export class OrderLinkController {
  constructor(private readonly links: OrderLinkService) {}

  @Get(':token')
  async show(
    @Param('token') token: string,
    @Query('cancel') cancel: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.links.viewLink(token);
    await send(reply, orderLinkPage(view, { askingToCancel: cancel !== undefined }));
  }

  /** Does what the customer asked, then redirects to the page, as for drafts. */
  @Post(':token')
  async act(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const action = field(body, 'action');
    if (action !== 'confirm' && action !== 'cancel') {
      await send(reply, { ...orderLinkPage(await this.links.viewLink(token)), status: 400 });
      return;
    }
    const shown = field(body, 'shown');
    const view =
      action === 'confirm'
        ? await this.links.confirmLink(token, shown)
        : await this.links.cancelLink(token, shown);
    if (view.kind === 'order' && !view.problem) return seeOther(reply, token);
    await send(reply, orderLinkPage(view));
  }
}

async function send(reply: FastifyReply, page: LinkPage): Promise<void> {
  await reply
    .code(page.status)
    .headers(PRIVATE_PAGE_HEADERS)
    .header('content-security-policy', page.contentSecurityPolicy)
    .header('content-type', 'text/html; charset=utf-8')
    .send(page.html);
}

/** To the page again, which a reload fetches rather than posting a second time. */
async function seeOther(reply: FastifyReply, token: string): Promise<void> {
  await reply.code(303).headers(PRIVATE_PAGE_HEADERS).header('location', token).send();
}

/** A text field of the posted form; empty when missing. */
function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value : '';
}
