import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CombinedListingService, type CombinedListingRecord } from '../combined-listings.js';
import type { ProductRecord } from '../records.js';
import {
  CombinedListing,
  CombinedListingDeletePayload,
  CombinedListingInput,
  CombinedListingPayload,
  CombinedListingProduct,
} from './combined-listing.types.js';
import { toProduct, uuidOf } from './mappers.js';
import { Product } from './product.types.js';

const NOT_FOUND = 'Combined listing not found';

/** An ID of no product, said of where it is, as one of another shop is. */
const NO_PRODUCT = '00000000-0000-0000-0000-000000000000';

function toCombinedListing(record: CombinedListingRecord): CombinedListing {
  return Object.assign(new CombinedListing(), {
    id: toPublicId('combinedListing', record.id),
    optionName: record.optionName,
    optionNameUr: record.optionNameUr,
    products: record.products.map((product) =>
      Object.assign(new CombinedListingProduct(), {
        productId: toPublicId('product', product.productId),
        value: product.value,
        valueUr: product.valueUr,
      }),
    ),
    oneCard: record.oneCard,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function payload(result: MutationResult<CombinedListingRecord>): CombinedListingPayload {
  return Object.assign(new CombinedListingPayload(), {
    combinedListing: result.ok ? toCombinedListing(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** Combined listings (CAT-23, ADR-799): read and changed as products are, and a field of them. */
@Resolver(() => Product)
export class CombinedListingResolver {
  constructor(private readonly service: CombinedListingService) {}

  @Query(() => [CombinedListing], {
    description: "The shop's combined listings, the newest first.",
  })
  @RequireScopes('read_products')
  async combinedListings(@CurrentTenant() tenant: TenantContext): Promise<CombinedListing[]> {
    return (await this.service.list(tenant)).map(toCombinedListing);
  }

  @Query(() => CombinedListing, { nullable: true })
  @RequireScopes('read_products')
  async combinedListing(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CombinedListing | null> {
    const listingId = tryFromPublicId(id, 'combinedListing');
    const record = listingId ? await this.service.get(tenant, listingId) : null;
    return record ? toCombinedListing(record) : null;
  }

  @ResolveField('combinedListing', () => CombinedListing, {
    nullable: true,
    description: 'The combined listing it is in, if any (ADR-799).',
  })
  @RequireScopes('read_products')
  async productCombinedListing(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<CombinedListing | null> {
    const loader = loaders.get<string, CombinedListingRecord>('catalog.combinedListings', (ids) =>
      this.service.ofProducts(tenant, ids),
    );
    const record = await loader.load(uuidOf('product', product.id));
    return record ? toCombinedListing(record) : null;
  }

  @Mutation(() => CombinedListingPayload, {
    description:
      'Makes a combined listing of products, or, given its ID, sets its option and products in ' +
      'place of those it had. Their pages offer one another as values of its option.',
  })
  @RequireScopes('write_products')
  async combinedListingSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('input') input: CombinedListingInput,
  ): Promise<CombinedListingPayload> {
    const listingId = id ? tryFromPublicId(id, 'combinedListing') : null;
    if (id && !listingId) return payload(failOne(['id'], 'NOT_FOUND', NOT_FOUND));
    return payload(
      await this.service.set(tenant, listingId, {
        optionName: input.optionName,
        optionNameUr: input.optionNameUr,
        products: input.products.map((product) => ({
          productId: tryFromPublicId(product.productId, 'product') ?? NO_PRODUCT,
          value: product.value,
          valueUr: product.valueUr,
        })),
        oneCard: input.oneCard,
      }),
    );
  }

  @Mutation(() => CombinedListingDeletePayload, {
    description: 'Deletes a combined listing: its products stay, each shown on its own again.',
  })
  @RequireScopes('write_products')
  async combinedListingDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CombinedListingDeletePayload> {
    const listingId = tryFromPublicId(id, 'combinedListing');
    const result = listingId
      ? await this.service.delete(tenant, listingId)
      : failOne<string>(['id'], 'NOT_FOUND', NOT_FOUND);
    return Object.assign(new CombinedListingDeletePayload(), {
      deletedCombinedListingId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** A listing's product, as the product it names. */
@Resolver(() => CombinedListingProduct)
export class CombinedListingProductResolver {
  constructor(private readonly service: CombinedListingService) {}

  @ResolveField(() => Product, { nullable: true, description: 'The product, whatever its status.' })
  @RequireScopes('read_products')
  async product(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: CombinedListingProduct,
  ): Promise<Product | null> {
    const loader = loaders.get<string, ProductRecord>('catalog.combinedListingProducts', (ids) =>
      this.service.productsOf(tenant, ids),
    );
    const record = await loader.load(uuidOf('product', item.productId));
    return record ? toProduct(record, tenant.currency) : null;
  }
}
