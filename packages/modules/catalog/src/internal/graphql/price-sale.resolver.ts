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
import { PriceSaleService, type PriceSaleRecord } from '../price-sales.js';
import type { ProductRecord } from '../records.js';
import { toProduct, uuidOf } from './mappers.js';
import {
  PriceSale,
  PriceSaleCreateInput,
  PriceSalePayload,
  PriceSaleStatus,
} from './price-sale.types.js';
import { Product } from './product.types.js';

const NOT_FOUND = 'No sale of the shop has this ID';

const STATUS: Record<PriceSaleRecord['state'], PriceSaleStatus> = {
  scheduled: PriceSaleStatus.SCHEDULED,
  running: PriceSaleStatus.RUNNING,
  ended: PriceSaleStatus.ENDED,
  cancelled: PriceSaleStatus.CANCELLED,
};

function toPriceSale(record: PriceSaleRecord): PriceSale {
  return Object.assign(new PriceSale(), {
    id: toPublicId('priceSale', record.id),
    name: record.name,
    percentOff: record.percentOff,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    status: STATUS[record.state],
    endedAt: record.endedAt,
    productsCount: record.productIds.length,
    productIds: record.productIds,
    createdAt: record.createdAt,
  });
}

function payload(result: MutationResult<PriceSaleRecord>): PriceSalePayload {
  return Object.assign(new PriceSalePayload(), {
    priceSale: result.ok ? toPriceSale(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** Sales set ahead (CAT-17, ADR-443): read and set as products are. */
@Resolver(() => PriceSale)
export class PriceSaleResolver {
  constructor(private readonly service: PriceSaleService) {}

  @Query(() => [PriceSale], {
    description: "The shop's sales, those starting latest first; the newest hundred.",
  })
  @RequireScopes('read_products')
  async priceSales(@CurrentTenant() tenant: TenantContext): Promise<PriceSale[]> {
    return (await this.service.list(tenant)).map(toPriceSale);
  }

  @Query(() => PriceSale, { nullable: true })
  @RequireScopes('read_products')
  async priceSale(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PriceSale | null> {
    const saleId = tryFromPublicId(id, 'priceSale');
    const record = saleId ? await this.service.get(tenant, saleId) : null;
    return record ? toPriceSale(record) : null;
  }

  @ResolveField(() => [Product], { description: 'Its products still kept, by title.' })
  @RequireScopes('read_products')
  async products(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() sale: PriceSale,
  ): Promise<Product[]> {
    const loader = loaders.get<string, ProductRecord[]>('catalog.priceSaleProducts', (ids) =>
      this.service.productsOf(tenant, ids),
    );
    const records = (await loader.load(uuidOf('priceSale', sale.id))) ?? [];
    return records.map((record) => toProduct(record, tenant.currency));
  }

  @Mutation(() => PriceSalePayload, {
    description:
      'Sets a sale ahead. One starting now, or a minute from now at most, starts at once; ' +
      'others within a minute of their time.',
  })
  @RequireScopes('write_products')
  async priceSaleCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PriceSaleCreateInput,
  ): Promise<PriceSalePayload> {
    const productIds = input.productIds.map((id) => tryFromPublicId(id, 'product'));
    const unknown = productIds.findIndex((id) => id === null);
    if (unknown >= 0) {
      return payload(
        failOne(['productIds', String(unknown)], 'NOT_FOUND', 'No product of the shop has this ID'),
      );
    }
    return payload(
      await this.service.create(tenant, {
        name: input.name,
        percentOff: input.percentOff,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        productIds: productIds as string[],
      }),
    );
  }

  @Mutation(() => PriceSalePayload, {
    description:
      'Cancels a sale not yet started, or ends one running now, its prices put back as at its ' +
      'end.',
  })
  @RequireScopes('write_products')
  async priceSaleCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PriceSalePayload> {
    const saleId = tryFromPublicId(id, 'priceSale');
    if (!saleId) return payload(failOne(['id'], 'NOT_FOUND', NOT_FOUND));
    return payload(await this.service.cancel(tenant, saleId));
  }
}
