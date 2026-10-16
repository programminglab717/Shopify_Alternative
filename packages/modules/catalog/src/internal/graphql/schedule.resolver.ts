import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import {
  Args,
  GraphQLISODateTime,
  ID,
  Mutation,
  Parent,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { ProductService } from '../product.service.js';
import type { ProductRecord } from '../records.js';
import { toProduct, toUserErrors, uuidOf } from './mappers.js';
import { Product, ProductUpdatePayload } from './product.types.js';

/** Drafts put on sale at a time ahead (CAT-17, ADR-441): a field of products, and setting it. */
@Resolver(() => Product)
export class ProductScheduleResolver {
  constructor(private readonly service: ProductService) {}

  @ResolveField(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'When the draft goes on sale by itself, made active by the worker within a minute of it ' +
      '(ADR-441); null for no time set.',
  })
  @RequireScopes('read_products')
  async publishAt(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<Date | null> {
    const loader = loaders.get<string, Date>('catalog.publishTimes', (ids) =>
      this.service.publishTimesOf(tenant, ids),
    );
    return (await loader.load(uuidOf('product', product.id))) ?? null;
  }

  @Mutation(() => ProductUpdatePayload, {
    description:
      'Puts a draft on sale by itself at `publishAt`, a minute to a year ahead, as a drop "goes ' +
      'live at 00:00"; null takes the time away. Set on sale or archived by hand, a product ' +
      'loses its time.',
  })
  @RequireScopes('write_products')
  async productSchedulePublish(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('publishAt', { type: () => GraphQLISODateTime, nullable: true })
    publishAt: Date | null,
  ): Promise<ProductUpdatePayload> {
    const id = tryFromPublicId(productId, 'product');
    const result = id
      ? await this.service.schedulePublish(tenant, id, publishAt ?? null)
      : failOne<ProductRecord>(['productId'], 'NOT_FOUND', 'Product not found');
    return Object.assign(new ProductUpdatePayload(), {
      product: result.ok ? toProduct(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }
}
