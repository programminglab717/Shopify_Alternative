import { PublicSite } from '@hatti/api';
import {
  CART_TOKEN_HEADER,
  checkoutPagePath,
  type CartErrorResponse,
  type CheckoutPageResponse,
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
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { checkoutPage } from './checkout-pages.js';
import {
  CHECKOUT_PATH,
  CheckoutService,
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
 * to order and the form, or the order once placed; POST places it. The secret is the only
 * credential: 128 random bits, unknown ones costing one indexed lookup. Only a POST changes
 * anything, and it then redirects to the page, so reloading it does not post again.
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
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.checkouts.place(token, field(body, 'shown'), formOf(body));
    await send(reply, token, responseOf(view, true));
  }
}

/**
 * Checkouts, as storefronts start them and show them on the shop's own address (ADR-044):
 * `POST /storefront/shops/{shop}/checkouts` makes one for the cart the `x-hatti-cart` header's
 * secret names, and answers where to send the shopper, or 422 when the cart has nothing to order;
 * `GET` and `POST …/checkouts/{secret}` give its page to send, as JSON, for the shop's checkouts
 * only. The host application checks the storefront key before any of this runs.
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
  ): Promise<CheckoutStartResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const secret = token ? await this.checkouts.start(shopId, token) : null;
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
  ): Promise<CheckoutPageResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const view = await this.checkouts.place(token, field(body, 'shown'), formOf(body), shopId);
    return responseOf(view, true);
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
    province: field(body, 'province'),
  };
}

/** A text field of the posted form; empty when missing. */
function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value : '';
}
