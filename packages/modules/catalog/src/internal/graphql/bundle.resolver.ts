import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { BundleService, type BundleRecord } from '../bundles.js';
import {
  ProductBundle,
  ProductBundleComponentInput,
  ProductBundleSetPayload,
} from './bundle.types.js';
import { uuidOf } from './mappers.js';
import { Product } from './product.types.js';

function toBundle(record: BundleRecord): ProductBundle {
  return Object.assign(new ProductBundle(), {
    productId: toPublicId('product', record.productId),
    complete: record.complete,
    components: record.components.map((part) => ({
      ...part,
      variantId: toPublicId('variant', part.variantId),
      productId: toPublicId('product', part.productId),
    })),
  });
}

/** Bundles and multipacks (CAT-11, ADR-409): a field of products, and setting it. */
@Resolver(() => Product)
export class BundleResolver {
  constructor(private readonly service: BundleService) {}

  @ResolveField(() => ProductBundle, {
    nullable: true,
    description: 'What it is made of, when it is a bundle; null when it is not (ADR-409).',
  })
  @RequireScopes('read_products')
  async bundle(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<ProductBundle | null> {
    const loader = loaders.get<string, BundleRecord>('catalog.bundles', (ids) =>
      this.service.of(tenant, ids),
    );
    const record = await loader.load(uuidOf('product', product.id));
    return record ? toBundle(record) : null;
  }

  @Mutation(() => ProductBundleSetPayload, {
    description:
      'Makes a product of one variant a bundle of other products’ variants, a number of each, ' +
      'in place of any parts it had; no parts, and it is a bundle no longer.',
  })
  @RequireScopes('write_products')
  async productBundleSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('components', { type: () => [ProductBundleComponentInput] })
    components: ProductBundleComponentInput[],
  ): Promise<ProductBundleSetPayload> {
    const id = tryFromPublicId(productId, 'product');
    const parts = components.map((part) => ({
      // An ID of no variant is said of its part, as one of another shop is.
      variantId:
        tryFromPublicId(part.variantId, 'variant') ?? '00000000-0000-0000-0000-000000000000',
      quantity: part.quantity,
    }));
    const result = id
      ? await this.service.set(tenant, id, parts)
      : failOne<BundleRecord | null>(['productId'], 'NOT_FOUND', 'Product not found');
    return Object.assign(new ProductBundleSetPayload(), {
      bundle: result.ok && result.value ? toBundle(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
