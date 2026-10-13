import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { Product } from '@hatti/catalog/public';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { PreorderService, type PreorderRecord } from '../preorders.js';
import { uuidOf } from './mappers.js';
import { ProductPreorder, ProductPreorderSetPayload } from './preorder.types.js';

function toPreorder(record: PreorderRecord): ProductPreorder {
  return Object.assign(new ProductPreorder(), {
    productId: toPublicId('product', record.productId),
    shipsOn: record.shipsOn,
  });
}

/** Pre-orders (CAT-14, ADR-403): a field of the catalog's products, and setting it. */
@Resolver(() => Product)
export class ProductPreorderResolver {
  constructor(private readonly service: PreorderService) {}

  @ResolveField(() => ProductPreorder, {
    nullable: true,
    description: 'Whether it is on pre-order, and the day it ships by; null when it is not.',
  })
  @RequireScopes('read_products')
  async preorder(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<ProductPreorder | null> {
    const productId = uuidOf('product', product.id);
    const loader = loaders.get<string, string>('inventory.preorders', (ids) =>
      this.service.of(tenant, ids),
    );
    const shipsOn = await loader.load(productId);
    return shipsOn ? toPreorder({ productId, shipsOn }) : null;
  }

  @Mutation(() => ProductPreorderSetPayload, {
    description:
      'Puts a product on pre-order, shipping by a day from today to a year ahead, or takes it ' +
      'off with a null day. On pre-order it sells whatever its stock.',
  })
  @RequireScopes('write_products')
  async productPreorderSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('shipsOn', { type: () => String, nullable: true }) shipsOn: string | null,
  ): Promise<ProductPreorderSetPayload> {
    const result = await this.service.set(tenant, uuidOf('product', productId), shipsOn ?? null);
    return Object.assign(new ProductPreorderSetPayload(), {
      preorder: result.ok && result.value ? toPreorder(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
