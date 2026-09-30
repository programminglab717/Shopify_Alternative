import {
  CART_ACTIONS,
  CART_TOKEN_HEADER,
  type CartActionName,
  type CartChangeResponse,
  type CartErrorResponse,
  type CartReadResponse,
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
  UnprocessableEntityException,
} from '@nestjs/common';
import { parseAction } from './cart-lines.js';
import { CartService } from './cart.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Carts, as storefronts reach them (ADR-042): `GET /storefront/shops/{shop}/cart` reads the cart
 * the `x-hatti-cart` header's secret names, and `POST …/cart/{add,change,update,clear}` changes it,
 * or a new cart, as Shopify's cart forms and Ajax cart do. 422 says why an action was refused.
 * The host application checks the storefront key before any of this runs.
 */
@Controller('storefront/shops/:shopId/cart')
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Get()
  @Header('cache-control', 'no-store')
  async read(
    @Param('shopId') shopId: string,
    @Headers(CART_TOKEN_HEADER) token: string | undefined,
  ): Promise<CartReadResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    return { cart: token ? await this.carts.cart(shopId, token) : null };
  }

  @Post(':action')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async act(
    @Param('shopId') shopId: string,
    @Param('action') name: string,
    @Headers(CART_TOKEN_HEADER) token: string | undefined,
    @Body() body: unknown,
  ): Promise<CartChangeResponse> {
    if (!UUID.test(shopId) || !CART_ACTIONS.includes(name as CartActionName)) {
      throw new NotFoundException();
    }
    const action = parseAction(name as CartActionName, body ?? {});
    if ('code' in action) throw refused(action);
    const result = await this.carts.act(shopId, token || null, action);
    if (!result.ok) throw refused(result.error);
    return { cart: result.cart, token: result.token, added: result.added };
  }
}

function refused(error: CartErrorResponse['error']): UnprocessableEntityException {
  return new UnprocessableEntityException({ error } satisfies CartErrorResponse);
}
