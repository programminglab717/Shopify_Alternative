import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ProductService } from '../product.service.js';
import { toProduct, toStatusValue, toUserErrors } from './mappers.js';
import {
  Product,
  ProductConnection,
  ProductCreateInput,
  ProductCreatePayload,
  ProductEdge,
  ProductUpdateInput,
  ProductUpdatePayload,
  ProductsArgs,
} from './product.types.js';

function productUuid(id: string): string {
  const uuid = tryFromPublicId(id, 'product');
  if (!uuid) throw badUserInput(`Invalid product id: ${id.slice(0, 64)}`);
  return uuid;
}

@Resolver(() => Product)
export class ProductResolver {
  constructor(private readonly service: ProductService) {}

  @Query(() => Product, { nullable: true, description: 'A product by ID, or null if not found.' })
  @RequireScopes('read_products')
  async product(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Product | null> {
    const record = await this.service.get(tenant, productUuid(id));
    return record ? toProduct(record, tenant.currency) : null;
  }

  @Query(() => ProductConnection, { description: 'Products, newest first.' })
  @RequireScopes('read_products')
  async products(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ProductsArgs,
  ): Promise<ProductConnection> {
    const first = pageSize(args.first);
    const after = args.after ? productUuid(decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first,
      after,
      query: args.query,
    });
    const nodes = items.map((item) => toProduct(item, tenant.currency));
    const edges = nodes.map((node) =>
      Object.assign(new ProductEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
    );
    return Object.assign(new ProductConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
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

  @Mutation(() => ProductUpdatePayload)
  @RequireScopes('write_products')
  async productUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ProductUpdateInput,
  ): Promise<ProductUpdatePayload> {
    const result = await this.service.update(tenant, {
      ...input,
      id: productUuid(input.id),
      status: input.status === undefined ? undefined : input.status && toStatusValue(input.status),
    });
    return Object.assign(new ProductUpdatePayload(), {
      product: result.ok ? toProduct(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }
}
