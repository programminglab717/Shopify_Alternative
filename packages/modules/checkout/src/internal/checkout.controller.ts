import { PublicSite } from '@hatti/api';
import { MARKETING_CHANNELS } from '@hatti/customers/public';
import { browserIdsOf } from '@hatti/orders/public';
import {
  ACCOUNT_TOKEN_HEADER,
  CART_TOKEN_HEADER,
  CLIENT_BROWSER_IDS_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_PROOF_HEADER,
  CLIENT_USER_AGENT_HEADER,
  NUMBER_PROOF_COOKIE,
  checkoutPagePath,
  numberProofCookie,
  type CartErrorResponse,
  type CheckoutPageResponse,
  type CheckoutStartRequest,
  type CheckoutStartResponse,
  type PaymentLinkOpenResponse,
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
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { REMINDER_LINK_PATH } from './abandoned.js';
import { AbandonedCheckoutService } from './abandoned.service.js';
import { checkoutPage } from './checkout-pages.js';
import { MARKETING_FIELDS } from './marketing.js';
import { PaymentLinkService } from './payment-link.service.js';
import {
  CHECKOUT_PATH,
  CheckoutService,
  PREFILL_FIELDS,
  paidNoticeOf,
  type CheckoutClient,
  type CheckoutForm,
  type CheckoutPrefill,
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
  async show(
    @Param('token') token: string,
    @Query('paid') paid: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.checkouts.view(token);
    // Back from paying online, once its payment is in (ADR-152).
    await send(
      reply,
      token,
      responseOf(paid === undefined ? view : paidNoticeOf(view, null), false),
    );
  }

  /**
   * Where the shop's gateway sends the shopper back once they paid online (ADR-152), with what it
   * says of the payment, posted or in the address: the payment is recorded if the gateway's
   * signature holds; then the thank-you page says so, or that it waits to hear.
   */
  @Post(':token/paid')
  async paidPosted(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.#paid(token, fieldsOf(body), reply);
  }

  @Get(':token/paid')
  async paidRedirected(
    @Param('token') token: string,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.#paid(token, fieldsOf(query), reply);
  }

  async #paid(token: string, form: Record<string, string>, reply: FastifyReply): Promise<void> {
    const view = await this.checkouts.paidOnline(token, form);
    if (view.kind === 'placed' && view.payment === 'paid') {
      await reply
        .code(303)
        .headers(PRIVATE_PAGE_HEADERS)
        .header('location', `/${CHECKOUT_PATH}/${token}?paid`)
        .send();
      return;
    }
    await send(reply, token, responseOf(view, false));
  }

  /**
   * The name and number the shopper typed, as the page's script sends them once the number is
   * whole (ADR-393): kept on the checkout, nothing shown. 204 whatever came of it.
   */
  @Post(':token/contact')
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  async contact(@Param('token') token: string, @Body() body: unknown): Promise<void> {
    await this.checkouts.keepContact(token, contactOf(body));
  }

  @Post(':token')
  async place(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const client = {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      // A number this browser proved lately at the shop's checkout (ADR-199).
      proof: cookieOf(request.headers.cookie, NUMBER_PROOF_COOKIE),
    };
    const view = await posted(this.checkouts, token, body, { client });
    const response = responseOf(view, true);
    if (response.placed && response.proof) {
      reply.header(
        'set-cookie',
        numberProofCookie(response.proof, { secure: request.protocol === 'https' }),
      );
    }
    await send(reply, token, response);
  }
}

/**
 * Checkouts, as storefronts start them and show them on the shop's own address (ADR-044):
 * `POST /storefront/shops/{shop}/checkouts` makes one for the cart the `x-hatti-cart` header's
 * secret names, keeping the visits its body's `visits` name (ADR-139), and answers where to send
 * the shopper, or 422 when the cart has nothing to order;
 * `GET` and `POST …/checkouts/{secret}` give its page to send, as JSON, for the shop's checkouts
 * only, the GET filled in for the shopper whose account session `x-hatti-account` names
 * (ADR-585), the POST with where the shopper placed the order from in `x-hatti-client-ip` and
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
    @Headers(ACCOUNT_TOKEN_HEADER) account: string | undefined,
    @Query() query: unknown,
  ): Promise<CheckoutPageResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    // Filled in for a shopper signed in to their account on the shop (ADR-585), and with what
    // the cart permalink that began it gives (ADR-709).
    const view = await this.checkouts.view(token, shopId, {
      account: account ?? null,
      prefill: prefillOf(query),
    });
    return responseOf(await withBook(this.checkouts, view, shopId, account), false);
  }

  /** The name and number the shopper typed, as on the core's own address (ADR-393). */
  @Post(':token/contact')
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  async contact(
    @Param('shopId') shopId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<void> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    await this.checkouts.keepContact(token, contactOf(body), shopId);
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
    @Headers(CLIENT_BROWSER_IDS_HEADER) browserIds: string | undefined,
    @Headers(CLIENT_PROOF_HEADER) proof: string | undefined,
    @Headers(ACCOUNT_TOKEN_HEADER) account: string | undefined,
  ): Promise<CheckoutPageResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const client = {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      proof: proof?.slice(0, 100) ?? null,
      // The shopper's session, proving the number it signed in with (ADR-586).
      account: account?.slice(0, 128) ?? null,
      // As a query string: `fbp=…&fbc=…`. The order keeps those in Meta's format.
      browserIds: browserIds
        ? browserIdsOf(Object.fromEntries(new URLSearchParams(browserIds.slice(0, 2048))))
        : null,
    };
    const view = await posted(this.checkouts, token, body, { shopId, client });
    return responseOf(await withBook(this.checkouts, view, shopId, client.account), true);
  }
}

/**
 * The page with the address book of the shopper signed in to their account (ADR-587), to deliver
 * to another of its addresses, and their number's store credit where the page offers to pay with
 * it (ADR-592); as it is without a session, or an open checkout.
 */
async function withBook(
  checkouts: CheckoutService,
  view: CheckoutView | { url: string },
  shopId: string,
  account: string | null | undefined,
): Promise<CheckoutView | { url: string }> {
  if (!account || 'url' in view || view.kind !== 'open') return view;
  const book = await checkouts.book(shopId, account);
  const credit = view.storeCredit ? await checkouts.creditOf(shopId, account) : null;
  return {
    ...view,
    ...(book && { book }),
    ...(credit !== null && { creditBalance: credit }),
  };
}

/**
 * The shop's payment links as the storefront opens them (ADR-248): `POST
 * …/payment-links/{token}`, with the visits that brought the shopper as a checkout's start has
 * them, gives where to send the shopper, a checkout of their own with the link's items; or, when
 * it opens none, the page saying why, to send as it is. The storefront opens it for each GET
 * of its address, as it follows a cart permalink. The host application checks the storefront key
 * before any of this runs.
 */
@Controller('storefront/shops/:shopId/payment-links')
export class StorefrontPaymentLinkController {
  constructor(
    private readonly links: PaymentLinkService,
    private readonly checkouts: CheckoutService,
    private readonly site: PublicSite,
  ) {}

  @Post(':token')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async open(
    @Param('shopId') shopId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<PaymentLinkOpenResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const visits = (body as CheckoutStartRequest | null)?.visits;
    const opened = await this.links.open(shopId, token, visits);
    if (opened.kind === 'checkout') {
      const path = checkoutPagePath(opened.secret);
      return { path, url: this.site.url(path) };
    }
    const reason = opened.kind === 'unavailable' ? 'sold_out' : opened.kind;
    const page = checkoutPage(await this.checkouts.linkPageView(shopId, reason));
    return {
      status: page.status,
      headers: {
        ...PRIVATE_PAGE_HEADERS,
        'content-security-policy': page.contentSecurityPolicy,
        'content-type': 'text/html; charset=utf-8',
      },
      html: page.html,
    };
  }
}

/**
 * Where a reminder's link takes the shopper who left a checkout (ADR-393): /r/<secret> on the
 * core's own address, as WhatsApp's buttons need one address for every shop, sends them on to
 * their shop's storefront, at a cart of the items they left; 404 for a link it knows not.
 */
@Controller(REMINDER_LINK_PATH)
export class ReminderLinkController {
  constructor(private readonly abandoned: AbandonedCheckoutService) {}

  @Get(':token')
  async open(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const target = await this.abandoned.reminderTarget(token);
    if (!target) {
      await reply
        .code(404)
        .headers(PRIVATE_PAGE_HEADERS)
        .header('content-type', 'text/plain; charset=utf-8')
        .send('This link is not known, or has expired.');
      return;
    }
    await reply.code(302).headers(PRIVATE_PAGE_HEADERS).header('location', target).send();
  }
}

/** What a cart permalink fills in of a checkout (ADR-709), as the page's address gives it. */
function prefillOf(query: unknown): CheckoutPrefill {
  return Object.fromEntries(
    Object.keys(PREFILL_FIELDS).map((name) => [name, field(query, name)]),
  ) as CheckoutPrefill;
}

/** The name and number a contact's body carries; blank for those it lacks. */
function contactOf(body: unknown): { name: string; phone: string } {
  return { name: field(body, 'name').slice(0, 200), phone: field(body, 'phone').slice(0, 40) };
}

/**
 * What a POST to a checkout's page does: applies the discount code it carries
 * (`action=discount`), takes the code off (`action=remove_discount`), applies a gift card or takes
 * it off (`action=gift_card`, `remove_gift_card`, ADR-449), adds the shop's gift wrap
 * or takes it off (`action=gift_wrap`, `remove_gift_wrap`, ADR-413), sends the shopper to the
 * shop's gateway to pay the order placed online (`action=pay`, ADR-152), fills in a returning
 * shopper's saved address once their number is proved, sending the code (`action=recall`, with
 * `channel=sms` for one by SMS) or checking it (`action=recall_code`, ADR-447), fills in
 * another address of a signed-in shopper's book (`action=use_address`, ADR-587), shows the page
 * with the form as typed for its total, placing nothing (`action=totals`, ADR-713), or places the
 * order.
 */
async function posted(
  checkouts: CheckoutService,
  token: string,
  body: unknown,
  options: { shopId?: string; client: CheckoutClient },
): Promise<CheckoutView | { url: string }> {
  switch (field(body, 'action')) {
    case 'totals':
      return checkouts.typed(token, formOf(body), options);
    case 'discount':
      return checkouts.applyDiscount(token, field(body, 'discount'), options);
    case 'remove_discount':
      return checkouts.removeDiscount(token, options);
    case 'gift_card':
      return checkouts.applyGiftCard(token, field(body, 'gift_card'), options);
    case 'remove_gift_card':
      return checkouts.removeGiftCard(token, options);
    case 'gift_wrap':
      return checkouts.giftWrap(token, true, options);
    case 'remove_gift_wrap':
      return checkouts.giftWrap(token, false, options);
    case 'pay':
      return checkouts.payOnline(token, { ...options, gateway: field(body, 'gateway') });
    case 'recall':
    case 'recall_code':
      return checkouts.recall(
        token,
        {
          phone: field(body, 'phone'),
          code: field(body, 'action') === 'recall_code' ? field(body, 'code') : null,
          channel: field(body, 'channel') === 'sms' ? 'sms' : 'whatsapp',
        },
        options,
      );
    case 'use_address':
      return checkouts.useAddress(token, field(body, 'address'), options);
    default:
      return checkouts.place(token, field(body, 'shown'), formOf(body), options);
  }
}

/**
 * The page to send, with its status and headers; once a POST placed the order, the page again;
 * or, asked to pay online, the gateway's page to send the shopper to.
 */
function responseOf(view: CheckoutView | { url: string }, posted: boolean): CheckoutPageResponse {
  if ('url' in view) return { placed: false, redirect: view.url };
  // The thank-you page with the gateway's form is the answer itself (ADR-163).
  if (posted && view.kind === 'placed' && !view.gatewayForm) {
    return { placed: true, ...(view.proof && { proof: view.proof }) };
  }
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
  if ('redirect' in response) {
    await reply
      .code(303)
      .headers(PRIVATE_PAGE_HEADERS)
      .header('location', response.redirect)
      .send();
    return;
  }
  await reply.code(response.status).headers(response.headers).send(response.html);
}

function formOf(body: unknown): CheckoutForm {
  return {
    name: field(body, 'name'),
    phone: field(body, 'phone'),
    email: field(body, 'email'),
    city: field(body, 'city'),
    address1: field(body, 'address1'),
    address2: field(body, 'address2'),
    landmark: field(body, 'landmark'),
    province: field(body, 'province'),
    payment: field(body, 'payment'),
    code: field(body, 'code').slice(0, 20),
    resend: field(body, 'resend'),
    storeCredit: field(body, 'storeCredit') === '1' ? '1' : '',
    storeCreditAmount: field(body, 'storeCreditAmount').slice(0, 20),
    // Each box for the shop's news and offers ticked (ADR-187).
    marketing: MARKETING_CHANNELS.filter(
      (channel) => field(body, MARKETING_FIELDS[channel]) === '1',
    ).join(' '),
    // The pin, where the shopper added their location (ADR-259).
    latitude: field(body, 'latitude').slice(0, 20),
    longitude: field(body, 'longitude').slice(0, 20),
    // A Google Maps link to the address, or its coordinates, for its pin (ADR-718).
    mapLink: field(body, 'map_link').slice(0, 500),
    // The location the shopper picks the order up at, where the page offered one (ADR-391).
    pickup: field(body, 'pickup').slice(0, 40),
    // A message to go with it as a gift, where the page asked for one (ADR-413).
    giftMessage: field(body, 'gift_message').slice(0, 250),
    // The time to deliver it in, of those the page offered (ADR-769).
    deliverySlot: field(body, 'delivery_slot').slice(0, 40),
    // The house and street the page asked more of, posted again (ADR-682).
    addressChecked: field(body, 'address_checked').slice(0, 500),
  };
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

/** The value of the cookie `name` of a request's `Cookie` header; null when it has none. */
function cookieOf(header: string | undefined, name: string): string | null {
  for (const pair of (header ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim() || null;
  }
  return null;
}

/** A text field of the posted form; empty when missing. */
function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value : '';
}
