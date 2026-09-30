import { Database } from '@hatti/db';
import { SEARCH_RESULTS, SEARCH_TERMS_MAX, type SearchResponse } from '@hatti/storefront-api';
import { Controller, Get, Header, NotFoundException, Param, Query } from '@nestjs/common';
import { ProductService } from './product.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Search, as storefronts reach it (ADR-046): `GET /storefront/shops/{shop}/search?q=` finds the
 * shop's active products with every word of `q`, best first, up to {@link SEARCH_RESULTS}. The
 * host application checks the storefront key before this runs.
 */
@Controller('storefront/shops/:shopId/search')
export class StorefrontSearchController {
  constructor(
    private readonly db: Database,
    private readonly products: ProductService,
  ) {}

  @Get()
  @Header('cache-control', 'no-store')
  async search(@Param('shopId') shopId: string, @Query('q') q: unknown): Promise<SearchResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const terms = typeof q === 'string' ? q.slice(0, SEARCH_TERMS_MAX) : '';
    const productIds = await this.db.tenant(shopId, (tx) =>
      this.products.searchIdsOf(tx, shopId, terms, SEARCH_RESULTS),
    );
    return { productIds };
  }
}
