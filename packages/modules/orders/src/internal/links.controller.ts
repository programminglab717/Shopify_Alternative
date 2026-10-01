import { isFormFile } from '@hatti/api';
import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DraftOrderService } from './draft-order.service.js';
import { draftLinkPage, orderLinkPage, type LinkPage } from './link-pages.js';
import { DRAFT_LINK_PATH, ORDER_LINK_PATH, type AddressForm, type LinkClient } from './links.js';
import { OrderLinkService, type OrderLinkView } from './order-link.service.js';
import type { ReceiptUpload } from './transfer-receipt.service.js';

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
 * The customer's side of a draft order's link, /d/<secret>: GET shows the order, and with
 * `?address` its address to fill in or correct; POST confirms it (`action=confirm`), from the
 * address and browser the request comes from (ADR-114), saves the address (`action=address`) or,
 * once its order waits for the advance it asked for, takes the receipt of the transfer
 * (`action=receipt`, a form with the file, ADR-085). The secret is the only credential; it is 128
 * random bits, and unknown ones cost one indexed lookup. Only a POST changes anything, so link
 * previews and scanners that fetch the page never place an order.
 */
@Controller(DRAFT_LINK_PATH)
export class DraftLinkController {
  constructor(private readonly drafts: DraftOrderService) {}

  @Get(':token')
  async show(
    @Param('token') token: string,
    @Query('address') address: string | undefined,
    @Query('saved') saved: string | undefined,
    @Query('sent') sent: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.drafts.viewLink(token);
    const form = address !== undefined ? 'address' : undefined;
    await send(
      reply,
      draftLinkPage(view, { form, saved: saved !== undefined, sent: sent !== undefined }),
    );
  }

  /**
   * Does what the customer asked, then redirects to the page, so reloading does not post again:
   * once the order is placed, or to the page saying the address is saved.
   */
  @Post(':token')
  async act(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const action = field(body, 'action');
    const shown = field(body, 'shown');
    if (action === 'confirm') {
      const view = await this.drafts.confirmLink(token, shown, clientOf(request));
      if (view.kind === 'completed' && !view.problem) return seeOther(reply, token);
      await send(reply, draftLinkPage(view));
    } else if (action === 'address') {
      const view = await this.drafts.changeAddress(token, shown, addressForm(body));
      if ((view.kind === 'open' || view.kind === 'completed') && !view.problem) {
        return seeOther(reply, `${token}?saved`);
      }
      await send(reply, draftLinkPage(view, { form: 'address' }));
    } else if (action === 'receipt') {
      const view = await this.drafts.sendReceipt(token, receiptOf(body));
      if (view.kind === 'completed' && !view.problem) return seeOther(reply, `${token}?sent`);
      // A draft not yet an order has no transfer to take a receipt for.
      await send(reply, { ...draftLinkPage(view), ...(view.kind === 'open' && { status: 400 }) });
    } else {
      await send(reply, { ...draftLinkPage(await this.drafts.viewLink(token)), status: 400 });
    }
  }
}

/**
 * The customer's side of an order's link, /o/<secret>: GET shows the order, with `?cancel` asks
 * whether they mean to cancel it, and with `?address` shows its address to correct. POST confirms
 * (`action=confirm`, from the address and browser the request comes from, ADR-115) or cancels
 * (`action=cancel`) a cash-on-delivery order that waits for them, saves a corrected address
 * (`action=address`), or takes the receipt of a transfer (`action=receipt`, a form with the file,
 * ADR-080). As for drafts, only a POST changes anything.
 */
@Controller(ORDER_LINK_PATH)
export class OrderLinkController {
  constructor(private readonly links: OrderLinkService) {}

  @Get(':token')
  async show(
    @Param('token') token: string,
    @Query('cancel') cancel: string | undefined,
    @Query('address') address: string | undefined,
    @Query('saved') saved: string | undefined,
    @Query('sent') sent: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.links.viewLink(token);
    const form = cancel !== undefined ? 'cancel' : address !== undefined ? 'address' : undefined;
    await send(
      reply,
      orderLinkPage(view, { form, saved: saved !== undefined, sent: sent !== undefined }),
    );
  }

  /**
   * Does what the customer asked, then redirects to the page, as for drafts: after a new address,
   * to the page saying it is saved.
   */
  @Post(':token')
  async act(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const action = field(body, 'action');
    const shown = field(body, 'shown');
    let view: OrderLinkView;
    switch (action) {
      case 'confirm':
        view = await this.links.confirmLink(token, shown, clientOf(request));
        break;
      case 'cancel':
        view = await this.links.cancelLink(token, shown);
        break;
      case 'address':
        view = await this.links.changeAddress(token, shown, addressForm(body));
        break;
      case 'receipt':
        view = await this.links.sendReceipt(token, receiptOf(body));
        break;
      default:
        await send(reply, { ...orderLinkPage(await this.links.viewLink(token)), status: 400 });
        return;
    }
    if (view.kind === 'order' && !view.problem) {
      return seeOther(
        reply,
        action === 'address' ? `${token}?saved` : action === 'receipt' ? `${token}?sent` : token,
      );
    }
    await send(reply, orderLinkPage(view, { form: action === 'address' ? action : undefined }));
  }
}

/** Where the request came from, as the core sees it: behind a proxy, with `TRUST_PROXY`. */
function clientOf(request: FastifyRequest): LinkClient {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

async function send(reply: FastifyReply, page: LinkPage): Promise<void> {
  await reply
    .code(page.status)
    .headers(PRIVATE_PAGE_HEADERS)
    .header('content-security-policy', page.contentSecurityPolicy)
    .header('content-type', 'text/html; charset=utf-8')
    .send(page.html);
}

/**
 * To the page again, which a reload fetches rather than posting a second time. `location` is
 * relative to the page: its secret, and what to show.
 */
async function seeOther(reply: FastifyReply, location: string): Promise<void> {
  await reply.code(303).headers(PRIVATE_PAGE_HEADERS).header('location', location).send();
}

/** The address fields of the posted form; the number counts only where the page asked for it. */
function addressForm(body: unknown): AddressForm {
  return {
    name: field(body, 'name'),
    address1: field(body, 'address1'),
    address2: field(body, 'address2'),
    landmark: field(body, 'landmark'),
    city: field(body, 'city'),
    province: field(body, 'province'),
    zip: field(body, 'zip'),
    phone: field(body, 'phone'),
  };
}

/** The receipt the form carried: its bytes, too many of them, or none. */
function receiptOf(body: unknown): ReceiptUpload {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).receipt : null;
  if (!isFormFile(value)) return null;
  if (value.truncated) return 'too_large';
  return value.data.length > 0 ? { data: value.data } : null;
}

/** A text field of the posted form; empty when missing. */
function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value : '';
}
