import type { FieldError } from '@hatti/api';
import {
  ACCOUNT_PRICES_MAX,
  ACCOUNT_TOKEN_HEADER,
  ACCOUNT_WISHLIST_MAX,
  CLIENT_IP_HEADER,
  accountPath,
  type AccountAddressRequest,
  type AccountAddressesResponse,
  type AccountDataEraseResponse,
  type AccountDataExportResponse,
  type AccountErrorResponse,
  type AccountLoginStartResponse,
  type AccountLoginVerifyErrorResponse,
  type AccountLoginVerifyResponse,
  type AccountOrderLinkResponse,
  type AccountResponse,
  type AccountSessionResponse,
  type AccountPricesResponse,
  type AccountWishlistResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AccountService, toSessionJson } from './account.service.js';
import { CartService } from './cart.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Shoppers' accounts, as storefronts reach them (CUS-02, ADR-570): `POST …/account/login` with
 * the `phone` typed, the `channel` and the storefront's `locale` sends a code to sign in with,
 * from the address in `x-hatti-client-ip`; `POST …/account/login/verify` with the `phone` and the
 * `code` signs in, answering the session's secret once; and, with that secret in
 * `x-hatti-account`, `GET …/account/session` reads the session, `GET …/account` the account,
 * `POST …/account/orders/{id}/link` the page of one of its orders, and `POST …/account/logout`
 * signs out. The shopper's own data (ADR-572): `POST …/account/data/export` makes their file, or
 * gives the one kept, and `GET` a new link to it; `POST …/account/data/erase` asks for their
 * erasure. Their wishlist (ADR-575): `GET …/account/wishlist` reads it, `POST` with `productIds`
 * adds to it, and `DELETE …/account/wishlist/{productId}` takes one off, each answering it as it
 * is then; IDs that name no product of the shop's are left out. Their address book (ADR-583):
 * `GET …/account/addresses` reads it, `POST` adds an address to it, `PUT …/account/addresses/{id}`
 * changes one and `DELETE` takes one out, each answering the book as it is then. Their prices
 * (ADR-781): `GET …/account/prices?variants=…`, at most {@link ACCOUNT_PRICES_MAX} variants' IDs
 * by commas, what one of each costs them where their price lists make it lower. 422 says what was
 * wrong with what was typed or sent; 404, that there is no session, or nothing to link to. The host application checks the storefront key before any of this runs.
 */
@Controller(accountPath(':shopId').slice(1))
export class StorefrontAccountController {
  constructor(
    private readonly accounts: AccountService,
    private readonly carts: CartService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async start(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
    @Headers(CLIENT_IP_HEADER) ip: string | undefined,
  ): Promise<AccountLoginStartResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const started = await this.accounts.startSignIn(
      shopId,
      {
        phone: field(body, 'phone').slice(0, 40),
        channel: field(body, 'channel') === 'sms' ? 'sms' : 'whatsapp',
        locale: field(body, 'locale').slice(0, 16),
      },
      { ip: ip ?? null },
    );
    if (started.kind === 'invalid') throw invalid(started.errors);
    return { state: started.kind, phone: started.phone, channel: started.channel };
  }

  @Post('login/verify')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async verify(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
  ): Promise<AccountLoginVerifyResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const verified = await this.accounts.verifySignIn(shopId, {
      phone: field(body, 'phone').slice(0, 40),
      code: field(body, 'code').slice(0, 20),
    });
    if (verified.kind !== 'signed_in') {
      throw new UnprocessableEntityException({
        error: verified.kind,
      } satisfies AccountLoginVerifyErrorResponse);
    }
    return { token: verified.token, session: toSessionJson(verified.session) };
  }

  @Get('session')
  @Header('cache-control', 'no-store')
  async session(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountSessionResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const session = token ? await this.accounts.session(shopId, token) : null;
    return { session: session && toSessionJson(session) };
  }

  @Post('logout')
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  async logout(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<void> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    if (token) await this.accounts.signOut(shopId, token);
  }

  @Get()
  @Header('cache-control', 'no-store')
  async account(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    return { account: token ? await this.accounts.account(shopId, token) : null };
  }

  @Post('orders/:orderId/link')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async orderLink(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountOrderLinkResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const link = token ? await this.accounts.orderLink(shopId, token, orderId) : null;
    if (!link) throw new NotFoundException();
    return link;
  }

  @Post('data/export')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async dataExport(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountDataExportResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const file = token ? await this.accounts.dataExport(shopId, token) : null;
    if (!file) throw new NotFoundException();
    return file;
  }

  @Get('data/export')
  @Header('cache-control', 'no-store')
  async dataExportLink(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountDataExportResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const file = token ? await this.accounts.dataExportLink(shopId, token) : null;
    if (!file) throw new NotFoundException();
    return file;
  }

  @Post('data/erase')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async dataErase(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountDataEraseResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const locale = field(body, 'locale').slice(0, 16);
    const erasure = token ? await this.accounts.dataErase(shopId, token, locale) : null;
    if (!erasure) throw new NotFoundException();
    return erasure;
  }

  @Get('prices')
  @Header('cache-control', 'no-store')
  async prices(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
    @Query('variants') variants: string | undefined,
  ): Promise<AccountPricesResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const asked = [...new Set((variants ?? '').split(',').map((each) => each.trim()))];
    if (asked.length > ACCOUNT_PRICES_MAX) {
      throw new UnprocessableEntityException(
        `variants must be at most ${ACCOUNT_PRICES_MAX} variants' IDs, by commas`,
      );
    }
    // One that could not be a variant's has no price of its own.
    const ids = asked.filter((each) => UUID.test(each));
    const prices = token ? await this.carts.listedPrices(shopId, token.slice(0, 128), ids) : null;
    if (!prices) throw new NotFoundException();
    return {
      prices: Object.fromEntries([...prices].map(([id, price]) => [id, Number(price)])),
    };
  }

  @Get('wishlist')
  @Header('cache-control', 'no-store')
  async wishlist(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountWishlistResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const productIds = token ? await this.accounts.wishlist(shopId, token) : null;
    if (!productIds) throw new NotFoundException();
    return { productIds };
  }

  @Post('wishlist')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async addToWishlist(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountWishlistResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const asked =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).productIds
        : undefined;
    if (
      !Array.isArray(asked) ||
      asked.length > ACCOUNT_WISHLIST_MAX ||
      !asked.every((id) => typeof id === 'string')
    ) {
      throw new UnprocessableEntityException({
        errors: [
          {
            field: 'productIds',
            message: `Send a list of at most ${ACCOUNT_WISHLIST_MAX} products' IDs`,
          },
        ],
      } satisfies AccountErrorResponse);
    }
    // An ID that could not be a product's names none the shop has, and is left out as those are.
    const wanted = (asked as string[]).filter((id) => UUID.test(id));
    const productIds = token ? await this.accounts.addToWishlist(shopId, token, wanted) : null;
    if (!productIds) throw new NotFoundException();
    return { productIds };
  }

  @Delete('wishlist/:productId')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async removeFromWishlist(
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountWishlistResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    // One that could not be a product's is in no wishlist: the list as it is.
    const productIds = !token
      ? null
      : UUID.test(productId)
        ? await this.accounts.removeFromWishlist(shopId, token, productId)
        : await this.accounts.wishlist(shopId, token);
    if (!productIds) throw new NotFoundException();
    return { productIds };
  }

  @Get('addresses')
  @Header('cache-control', 'no-store')
  async addresses(
    @Param('shopId') shopId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountAddressesResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const addresses = token ? await this.accounts.addresses(shopId, token) : null;
    if (!addresses) throw new NotFoundException();
    return { addresses };
  }

  @Post('addresses')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async addAddress(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountAddressesResponse> {
    return this.#saveAddress(shopId, body, token, null);
  }

  @Put('addresses/:addressId')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async changeAddress(
    @Param('shopId') shopId: string,
    @Param('addressId') addressId: string,
    @Body() body: unknown,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountAddressesResponse> {
    return this.#saveAddress(shopId, body, token, addressId);
  }

  @Delete('addresses/:addressId')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async deleteAddress(
    @Param('shopId') shopId: string,
    @Param('addressId') addressId: string,
    @Headers(ACCOUNT_TOKEN_HEADER) token: string | undefined,
  ): Promise<AccountAddressesResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const addresses = token ? await this.accounts.deleteAddress(shopId, token, addressId) : null;
    if (!addresses) throw new NotFoundException();
    return { addresses };
  }

  async #saveAddress(
    shopId: string,
    body: unknown,
    token: string | undefined,
    addressId: string | null,
  ): Promise<AccountAddressesResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const saved = token
      ? await this.accounts.saveAddress(shopId, token, addressBody(body), addressId)
      : null;
    if (!saved) throw new NotFoundException();
    if (saved.kind === 'invalid') throw invalid(saved.errors);
    return { addresses: saved.addresses };
  }
}

/** The address a JSON body sends, its text fields blank or null where it lacks them. */
function addressBody(body: unknown): AccountAddressRequest {
  const optional = (name: string): string | null => field(body, name) || null;
  return {
    name: field(body, 'name'),
    phone: field(body, 'phone'),
    address1: field(body, 'address1'),
    address2: optional('address2'),
    landmark: optional('landmark'),
    city: field(body, 'city'),
    province: optional('province'),
    zip: optional('zip'),
    default:
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).default === true
        : false,
  };
}

/** A 422 saying what was wrong, as the storefront shows it. */
function invalid(errors: FieldError[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    errors: errors.map(({ field, message }) => ({ field: field.join('.'), message })),
  } satisfies AccountErrorResponse);
}

/** A text field of a JSON body; blank for one it lacks. */
function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value : '';
}
