import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { invoicePage } from './billing-pages.js';
import { BILLING_PATH, BILLING_WEBHOOK_PATH, BillingService } from './billing.service.js';

/** Sent with every invoice's page: never cached, indexed or framed. */
const PRIVATE_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * Invoices' pages on the API's own address (ADR-154): where Hatti's gateway sends the shop's
 * owner back once they paid, with what it says of the payment, posted or in the address; the
 * payment is recorded if Hatti's signature holds, and the page then says how the invoice stands.
 */
@Controller(BILLING_PATH)
export class BillingPagesController {
  constructor(private readonly billing: BillingService) {}

  @Get(':id')
  async show(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    await send(reply, invoicePage(await this.billing.pageOf(id)));
  }

  @Post(':id/paid')
  async paidPosted(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.#paid(id, fieldsOf(body), reply);
  }

  @Get(':id/paid')
  async paidRedirected(
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.#paid(id, fieldsOf(query), reply);
  }

  async #paid(id: string, form: Record<string, string>, reply: FastifyReply): Promise<void> {
    const view = await this.billing.returned(id, form);
    if (!view) {
      await send(reply, invoicePage(null));
      return;
    }
    // Back to the invoice's page, so that reloading it posts nothing again.
    await reply
      .code(303)
      .headers(PRIVATE_PAGE_HEADERS)
      .header('location', `/${BILLING_PATH}/${encodeURIComponent(id)}`)
      .send();
  }
}

/**
 * Hatti's own gateway's webhook (ADR-154): a payment it says is made, signed with Hatti's secret,
 * pays its invoice, once. The host keeps each request's raw body as `rawBody`.
 */
@Controller(BILLING_WEBHOOK_PATH)
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ): Promise<{ received: boolean }> {
    if (!request.rawBody) throw new BadRequestException('The request has no body');
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    const outcome = await this.billing.webhook({ body: request.rawBody, headers });
    if (outcome === 'not_found') throw new NotFoundException('Hatti takes no payments online here');
    if (outcome === 'unsigned') {
      throw new UnauthorizedException("The request is not signed with Hatti's secret");
    }
    return { received: outcome === 'paid' };
  }
}

async function send(
  reply: FastifyReply,
  page: { status: number; html: string; contentSecurityPolicy: string },
): Promise<void> {
  await reply
    .code(page.status)
    .headers({
      ...PRIVATE_PAGE_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': page.contentSecurityPolicy,
    })
    .send(page.html);
}

/** The text fields of a posted form or a query, at most 50, each at most 500 characters. */
function fieldsOf(body: unknown): Record<string, string> {
  if (typeof body !== 'object' || body === null) return {};
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(body).slice(0, 50)) {
    if (typeof value === 'string') fields[name] = value.slice(0, 500);
  }
  return fields;
}
