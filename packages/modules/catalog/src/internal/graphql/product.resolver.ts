import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CollectionService } from '../collection.service.js';
import { ProductService } from '../product.service.js';
import type { CollectionRecord, Page } from '../records.js';
import { CollectionConnection } from './collection.types.js';
import {
  productSearch,
  toCollectionConnection,
  toProduct,
  toProductConnection,
  toStatusValue,
  toUserErrors,
  uuidOf,
} from './mappers.js';
import {
  PageArgs,
  Product,
  ProductConnection,
  ProductCreateInput,
  ProductCreatePayload,
  ProductDeleteInput,
  ProductDeletePayload,
  ProductDuplicatePayload,
  ProductStatus,
  ProductUpdateInput,
  ProductUpdatePayload,
  ProductsArgs,
} from './product.types.js';

const FACET_LIMIT = { defaultValue: 100, description: '1 to 250, most used first.' };

@Resolver(() => Product)
export class ProductResolver {
  constructor(
    private readonly service: ProductService,
    private readonly collectionService: CollectionService,
  ) {}

  @Query(() => Product, { nullable: true, description: 'A product by ID, or null if not found.' })
  @RequireScopes('read_products')
  async product(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Product | null> {
    const record = await this.service.get(tenant, uuidOf('product', id));
    return record ? toProduct(record, tenant.currency) : null;
  }

  @Query(() => Product, { nullable: true, description: 'A product by handle, or null.' })
  @RequireScopes('read_products')
  async productByHandle(
    @CurrentTenant() tenant: TenantContext,
    @Args('handle') handle: string,
  ): Promise<Product | null> {
    const record = await this.service.getByHandle(tenant, handle);
    return record ? toProduct(record, tenant.currency) : null;
  }

  @Query(() => ProductConnection, { description: 'Products, newest first.' })
  @RequireScopes('read_products')
  async products(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ProductsArgs,
  ): Promise<ProductConnection> {
    const first = pageSize(args.first);
    const after = args.after ? uuidOf('product', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first,
      after,
      query: productSearch(args.query),
    });
    const nodes = items.map((item) => toProduct(item, tenant.currency));
    return toProductConnection(
      nodes,
      nodes.map((node) => encodeCursor({ id: node.id })),
      hasNextPage,
    );
  }

  @Query(() => [String], { description: 'Tags in use, for pickers and filters.' })
  @RequireScopes('read_products')
  productTags(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, ...FACET_LIMIT }) first: number,
  ): Promise<string[]> {
    return this.service.facetValues(tenant, 'tags', pageSize(first));
  }

  @Query(() => [String], { description: 'Product types in use.' })
  @RequireScopes('read_products')
  productTypes(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, ...FACET_LIMIT }) first: number,
  ): Promise<string[]> {
    return this.service.facetValues(tenant, 'productType', pageSize(first));
  }

  @Query(() => [String], { description: 'Vendors in use.' })
  @RequireScopes('read_products')
  productVendors(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, ...FACET_LIMIT }) first: number,
  ): Promise<string[]> {
    return this.service.facetValues(tenant, 'vendor', pageSize(first));
  }

  @ResolveField(() => CollectionConnection, { description: 'The collections it is in, by id.' })
  async collections(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
    @Args() args: PageArgs,
  ): Promise<CollectionConnection> {
    const after = args.after ? uuidOf('collection', decodeCursor(args.after, ['id']).id) : null;
    const first = pageSize(args.first);
    // The products of a list ask for the same page of theirs, so they share one loader.
    const loader = loaders.get<string, Page<CollectionRecord>>(
      `catalog.productCollections:${first}:${after ?? ''}`,
      (productIds) =>
        this.collectionService.collectionsOfProducts(tenant, productIds, { first, after }),
    );
    const page = await loader.load(uuidOf('product', product.id));
    return toCollectionConnection(page?.items ?? [], page?.hasNextPage ?? false);
  }

  @Mutation(() => ProductCreatePayload)
  @RequireScopes('write_products')
  async productCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ProductCreateInput,
  ): Promise<ProductCreatePayload> {
    const result = await this.service.create(tenant, {
      ...input,
      status: input.status ? toStatusValue(input.status) : null,
    });
    return Object.assign(new ProductCreatePayload(), {
      product: result.ok ? toProduct(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductDuplicatePayload, {
    description:
      "Copies a product (ADR-343), as Shopify's productDuplicate does: titled `newTitle`, its " +
      'handle made from that, with its description, vendor, type, tags and words for search ' +
      'engines; its options and variants with their prices, costs, weights and tax, not their ' +
      'SKUs or barcodes; in the manual collections it is in; and its variants tracked as its are, ' +
      'with none of their stock. With `includeImages`, its photos and videos too, made again from ' +
      "where they came. Its status is `newStatus`, else the product's own.",
  })
  @RequireScopes('write_products')
  async productDuplicate(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('newTitle') newTitle: string,
    @Args('newStatus', { type: () => ProductStatus, nullable: true })
    newStatus: ProductStatus | null,
    @Args('includeImages', { type: () => Boolean, nullable: true, defaultValue: false })
    includeImages: boolean | null,
  ): Promise<ProductDuplicatePayload> {
    const result = await this.service.duplicate(tenant, {
      productId: uuidOf('product', productId),
      newTitle,
      newStatus: newStatus ? toStatusValue(newStatus) : null,
      includeImages,
    });
    return Object.assign(new ProductDuplicatePayload(), {
      newProduct: result.ok ? toProduct(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductUpdatePayload)
  @RequireScopes('write_products')
  async productUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ProductUpdateInput,
  ): Promise<ProductUpdatePayload> {
    const result = await this.service.update(tenant, {
      ...input,
      id: uuidOf('product', input.id),
      status: input.status === undefined ? undefined : input.status && toStatusValue(input.status),
    });
    return Object.assign(new ProductUpdatePayload(), {
      product: result.ok ? toProduct(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductDeletePayload, {
    description: 'Deletes a product with its variants, options and media.',
  })
  @RequireScopes('write_products')
  async productDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ProductDeleteInput,
  ): Promise<ProductDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('product', input.id));
    return Object.assign(new ProductDeletePayload(), {
      deletedProductId: result.ok ? input.id : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }
}
