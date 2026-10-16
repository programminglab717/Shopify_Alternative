import { VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { StockWatchService } from '@hatti/messaging/public';
import {
  stockWatchesPath,
  type StockWatchErrorResponse,
  type StockWatchResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Back in stock (ADR-429), as storefronts send shoppers' wishes on:
 * `POST /storefront/shops/{shop}/stock-watches` with the variant found sold out, the number typed
 * and the page's language. A variant the shop does not sell on its storefront is refused; the
 * messaging module keeps the wish, or says why not. The host application checks the storefront
 * key before any of this runs.
 */
@Controller(stockWatchesPath(':shopId').slice(1))
export class StockWatchController {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly watches: StockWatchService,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async watch(@Param('shopId') shopId: string, @Body() body: unknown): Promise<StockWatchResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : '');
    const refuse = (errors: StockWatchErrorResponse['errors']) =>
      new UnprocessableEntityException({ errors } satisfies StockWatchErrorResponse);
    const variantId = text('variantId');
    const snapshot = UUID.test(variantId)
      ? (
          await this.db.tenant(shopId, (tx) => this.variants.snapshotsOf(tx, shopId, [variantId]))
        ).get(variantId)
      : undefined;
    // Only what the storefront shows: a variant of an active product of the shop's.
    if (snapshot?.productStatus !== 'active') {
      throw refuse([{ field: 'variant', message: "The shop doesn't sell this" }]);
    }
    const result = await this.watches.watch(shopId, {
      variantId,
      productId: snapshot.productId,
      phone: text('phone'),
      language: text('language') === 'ur' ? 'ur' : 'en',
    });
    if (!result.ok) throw refuse(result.errors);
    return { created: result.created };
  }
}
