import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { ComplementService } from '../complements.js';
import type { ProductRecord } from '../records.js';
import { ProductComplementsSetPayload } from './complement.types.js';
import { toProduct, uuidOf } from './mappers.js';
import { Product } from './product.types.js';

/** The products a shop pairs with one (MKT-09, ADR-435): a field of products, and setting it. */
@Resolver(() => Product)
export class ComplementResolver {
  constructor(private readonly service: ComplementService) {}

  @ResolveField(() => [Product], {
    description:
      'The products the shop pairs with it, in its order, at most 10: what its page and the ' +
      'cart recommend beside it as complementary (ADR-435).',
  })
  @RequireScopes('read_products')
  async complementaryProducts(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<Product[]> {
    const loader = loaders.get<string, ProductRecord[]>('catalog.complements', (ids) =>
      this.service.productsOf(tenant, ids),
    );
    const records = (await loader.load(uuidOf('product', product.id))) ?? [];
    return records.map((record) => toProduct(record, tenant.currency));
  }

  @Mutation(() => ProductComplementsSetPayload, {
    description:
      'Pairs a product with other products of the shop, in their order, in place of those it ' +
      'had, at most 10; none, and it pairs with none.',
  })
  @RequireScopes('write_products')
  async productComplementsSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('complementIds', { type: () => [ID] }) complementIds: string[],
  ): Promise<ProductComplementsSetPayload> {
    const id = tryFromPublicId(productId, 'product');
    // An ID of no product is said of where it is, as one of another shop is.
    const ids = complementIds.map(
      (each) => tryFromPublicId(each, 'product') ?? '00000000-0000-0000-0000-000000000000',
    );
    const result = id
      ? await this.service.set(tenant, id, ids)
      : failOne<string[]>(['productId'], 'NOT_FOUND', 'Product not found');
    const records =
      result.ok && id ? ((await this.service.productsOf(tenant, [id])).get(id) ?? []) : [];
    return Object.assign(new ProductComplementsSetPayload(), {
      complementaryProducts: result.ok
        ? records.map((record) => toProduct(record, tenant.currency))
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
