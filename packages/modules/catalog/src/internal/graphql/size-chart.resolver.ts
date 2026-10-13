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
import {
  SizeChartService,
  type SizeChartInput as SizeChartInputValue,
  type SizeChartRecord,
} from '../size-charts.js';
import { optionalUuidOf, uuidOf } from './mappers.js';
import { Product } from './product.types.js';
import {
  ProductsSizeChartSetPayload,
  SizeChart,
  SizeChartDeletePayload,
  SizeChartInput,
  SizeChartPayload,
  SizeChartUnit,
} from './size-chart.types.js';

const NOT_FOUND = 'No size chart of the shop has this ID';

function toSizeChart(record: SizeChartRecord): SizeChart {
  return Object.assign(new SizeChart(), {
    id: toPublicId('sizeChart', record.id),
    name: record.name,
    unit: record.unit === 'in' ? SizeChartUnit.INCHES : SizeChartUnit.CENTIMETERS,
    columns: record.columns,
    rows: record.rows,
    note: record.note,
    productsCount: record.productCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toInput(input: SizeChartInput): SizeChartInputValue {
  return {
    ...('name' in input && { name: input.name ?? null }),
    ...('unit' in input && {
      unit: input.unit ? (input.unit === SizeChartUnit.INCHES ? 'in' : 'cm') : null,
    }),
    ...('columns' in input && { columns: input.columns ?? null }),
    ...('rows' in input && { rows: input.rows ?? null }),
    ...('note' in input && { note: input.note ?? null }),
  };
}

function payload(result: MutationResult<SizeChartRecord>): SizeChartPayload {
  return Object.assign(new SizeChartPayload(), {
    sizeChart: result.ok ? toSizeChart(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** Size charts (CAT-10, ADR-406): read and changed as products are, and a field of products. */
@Resolver(() => Product)
export class SizeChartResolver {
  constructor(private readonly service: SizeChartService) {}

  @Query(() => [SizeChart], { description: "The shop's size charts, by name; 50 at most." })
  @RequireScopes('read_products')
  async sizeCharts(@CurrentTenant() tenant: TenantContext): Promise<SizeChart[]> {
    return (await this.service.list(tenant)).map(toSizeChart);
  }

  @Query(() => SizeChart, { nullable: true })
  @RequireScopes('read_products')
  async sizeChart(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SizeChart | null> {
    const chartId = tryFromPublicId(id, 'sizeChart');
    const record = chartId ? await this.service.get(tenant, chartId) : null;
    return record ? toSizeChart(record) : null;
  }

  @ResolveField('sizeChart', () => SizeChart, {
    nullable: true,
    description: 'The size chart its page shows, if any (ADR-406).',
  })
  @RequireScopes('read_products')
  async productSizeChart(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<SizeChart | null> {
    const loader = loaders.get<string, SizeChartRecord>('catalog.sizeCharts', (ids) =>
      this.service.ofProducts(tenant, ids),
    );
    const record = await loader.load(uuidOf('product', product.id));
    return record ? toSizeChart(record) : null;
  }

  @Mutation(() => SizeChartPayload)
  @RequireScopes('write_products')
  async sizeChartCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SizeChartInput,
  ): Promise<SizeChartPayload> {
    return payload(await this.service.create(tenant, toInput(input)));
  }

  @Mutation(() => SizeChartPayload, {
    description: 'Changes a chart; the products showing it show it changed.',
  })
  @RequireScopes('write_products')
  async sizeChartUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: SizeChartInput,
  ): Promise<SizeChartPayload> {
    const chartId = tryFromPublicId(id, 'sizeChart');
    if (!chartId) return payload(failOne(['id'], 'NOT_FOUND', NOT_FOUND));
    return payload(await this.service.update(tenant, chartId, toInput(input)));
  }

  @Mutation(() => SizeChartDeletePayload, {
    description: 'Deletes a chart; the products that showed it show none.',
  })
  @RequireScopes('write_products')
  async sizeChartDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SizeChartDeletePayload> {
    const chartId = tryFromPublicId(id, 'sizeChart');
    const result = chartId
      ? await this.service.delete(tenant, chartId)
      : failOne<string>(['id'], 'NOT_FOUND', NOT_FOUND);
    return Object.assign(new SizeChartDeletePayload(), {
      deletedSizeChartId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ProductsSizeChartSetPayload, {
    description:
      'Gives products a size chart in place of any they had, or takes theirs away with a null ' +
      '`sizeChartId`: up to 250 by their IDs, and those a collection has now. Products added to ' +
      'the collection later are given none.',
  })
  @RequireScopes('write_products')
  async productsSizeChartSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('sizeChartId', { type: () => ID, nullable: true }) sizeChartId: string | null,
    @Args('productIds', { type: () => [ID], nullable: true }) productIds?: string[] | null,
    @Args('collectionId', { type: () => ID, nullable: true }) collectionId?: string | null,
  ): Promise<ProductsSizeChartSetPayload> {
    const chartId = sizeChartId ? tryFromPublicId(sizeChartId, 'sizeChart') : null;
    const result =
      sizeChartId && !chartId
        ? failOne<string[]>(['sizeChartId'], 'NOT_FOUND', NOT_FOUND)
        : await this.service.setForProducts(tenant, chartId, {
            productIds: (productIds ?? []).map((id) => uuidOf('product', id)),
            collectionId: optionalUuidOf('collection', collectionId ?? null),
          });
    return Object.assign(new ProductsSizeChartSetPayload(), {
      productIds: result.ok ? result.value.map((id) => toPublicId('product', id)) : [],
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
