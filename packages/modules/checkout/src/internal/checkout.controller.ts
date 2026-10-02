import { PublicSite } from '@hatti/api';
import {
  CART_TOKEN_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_USER_AGENT_HEADER,
  checkoutPagePath,
  type CartErrorResponse,
  type CheckoutPageResponse,
  type CheckoutStartRequest,
  type CheckoutStartResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { checkoutPage } from './checkout-pages.js';
import {
  CHECKOUT_PATH,
  CheckoutService,
  type CheckoutClient,
  type CheckoutForm,
  type CheckoutView,
} from './checkout.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Sent with every page: the address carries the checkout's secret, so the page is never cached,
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
 * A checkout's page on the core's own address, /checkouts/<secret> (ADR-044): GET shows the cart
 * to order and the form, or the order once placed; POST places it, or with an `action` applies a
 * discount code or takes it off. The secret is the only credential: 128 random bits, unknown ones
 * costing one indexed lookup. Only a POST changes anything, and placing the order then redirects
 * to the page, so reloading it does not post again.
 */
@Controller(CHECKOUT_PATH)
export class CheckoutController {
  constructor(private readonly checkouts: CheckoutService) {}

  @Get(':token')
  async show(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    await send(reply, token, responseOf(await this.checkouts.view(token), false));
  }

  @Post(':token')
  async place(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const client = { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
    const view = await posted(this.checkouts, token, body, { client });
    await send(reply, token, responseOf(view, true));
  }
}

/**
 * Checkouts, as storefronts start them and show them on the shop's own address (ADR-044):
 * `POST /storefront/shops/{shop}/checkouts` makes one for the cart the `x-hatti-cart` header's
 * secret names, keeping the visits its body's `visits` name (ADR-139), and answers where to send
 * the shopper, or 422 when the cart has nothing to order;
 * `GET` and `POST …/checkouts/{secret}` give its page to send, as JSON, for the shop's checkouts
 * only, the POST with where the shopper placed the order from in `x-hatti-client-ip` and
 * `x-hatti-client-user-agent`. The host application checks the storefront key before any of this
 * runs.
 */
@Controller('storefront/shops/:shopId/checkouts')
export class StorefrontCheckoutController {
  constructor(
    private readonly checkouts: CheckoutService,
    private readonly site: PublicSite,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async start(
    @Param('shopId') shopId: string,
    @Headers(CART_TOKEN_HEADER) token: string | undefined,
    @Body() body: unknown,
  ): Promise<CheckoutStartResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const visits = (body as CheckoutStartRequest | null)?.visits;
    const secret = token ? await this.checkouts.start(shopId, token, visits) : null;
    if (!secret) {
      throw new UnprocessableEntityException({
        error: { code: 'EMPTY' },
      } satisfies CartErrorResponse);
    }
    const path = checkoutPagePath(secret);
    return { path, url: this.site.url(path) };
  }

  @Get(':token')
  @Header('cache-control', 'no-store')
  async show(
    @Param('shopId') shopId: string,
    @Param('token') token: string,
  ): Promise<CheckoutPageResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    return responseOf(await this.checkouts.view(token, shopId), false);
  }

  @Post(':token')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async place(
    @Param('shopId') shopId: string,
    @Param('token') token: string,
    @Body() body: unknown,
    @Headers(CLIENT_IP_HEADER) ip: string | undefined,
    @Headers(CLIENT_USER_AGENT_HEADER) userAgent: string | undefined,
  ): Promise<CheckoutPageResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const client = { ip: ip ?? null, userAgent: userAgent ?? null };
    const view = await posted(this.checkouts, token, body, { shopId, client });
    return responseOf(view, true);
  }
}

/**
 * What a POST to a checkout's page does: applies the discount code it carries
 * (`action=discount`), takes the code off (`action=remove_discount`), or places the order.
 */
async function posted(
  checkouts: CheckoutService,
  token: string,
  body: unknown,
  options: { shopId?: string; client: CheckoutClient },
): Promise<CheckoutView> {
  switch (field(body, 'action')) {
    case 'discount':
      return checkouts.applyDiscount(token, field(body, 'discount'), options);
    case 'remove_discount':
      return checkouts.removeDiscount(token, options);
    default:
      return checkouts.place(token, field(body, 'shown'), formOf(body), options);
  }
}

/** The page to send, with its status and headers; or, once a POST placed the order, the page again. */
function responseOf(view: CheckoutView, posted: boolean): CheckoutPageResponse {
  if (posted && view.kind === 'placed') return { placed: true };
  const page = checkoutPage(view);
  return {
    placed: false,
    status: page.status,
    headers: {
      ...PRIVATE_PAGE_HEADERS,
      'content-security-policy': page.contentSecurityPolicy,
      'content-type': 'text/html; charset=utf-8',
    },
    html: page.html,
  };
}

async function send(reply: FastifyReply, token: string, response: CheckoutPageResponse) {
  if (response.placed) {
    // Relative, so that it works wherever the page is: /checkouts/<secret> on any address.
    await reply.code(303).headers(PRIVATE_PAGE_HEADERS).header('location', token).send();
    return;
  }
  await reply.code(response.status).headers(response.headers).send(response.html);
}

function formOf(body: unknown): CheckoutForm {
  return {
    name: field(body, 'name'),
    phone: field(body, 'phone'),
    city: field(body, 'city'),
    address1: field(body, 'address1'),
    address2: field(body, 'address2'),
    landmark: field(body, 'landmark'),
    province: field(body, 'province'),
    payment: field(body, 'payment'),
  };
}

/** A text field of the posted form; empty when missing. */
function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value : '';
}
