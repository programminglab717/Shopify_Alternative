import {
  CurrentTenant,
  RequireScopes,
  UserError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DropService, dropStatus, type DropRecord } from '../drops.js';
import {
  Drop,
  DropDeletePayload,
  DropInput,
  DropPayload,
  DropProduct,
  DropStatus,
} from './drop.types.js';

/** An ID of no product, said of where it is, as one of another shop is. */
const NO_PRODUCT = '00000000-0000-0000-0000-000000000000';

function toDrop(record: DropRecord): Drop {
  return Object.assign(new Drop(), {
    id: toPublicId('drop', record.id),
    name: record.name,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    status: dropStatus(record, new Date()).toUpperCase() as DropStatus,
    perCustomerLimit: record.perCustomer,
    admitPerMinute: record.admitPerMinute,
    products: record.products.map((product) =>
      Object.assign(new DropProduct(), {
        id: toPublicId('product', product.id),
        title: product.title,
        status: product.status.toUpperCase(),
      }),
    ),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function payload(result: MutationResult<DropRecord>): DropPayload {
  return Object.assign(new DropPayload(), {
    drop: result.ok ? toDrop(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** Drops (ADR-820): read and changed as products are. */
@Resolver()
export class DropResolver {
  constructor(private readonly service: DropService) {}

  @Query(() => [Drop], { description: "The shop's drops, the latest to start first." })
  @RequireScopes('read_products')
  async drops(@CurrentTenant() tenant: TenantContext): Promise<Drop[]> {
    return (await this.service.list(tenant)).map(toDrop);
  }

  @Query(() => Drop, { nullable: true })
  @RequireScopes('read_products')
  async drop(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Drop | null> {
    const uuid = tryFromPublicId(id, 'drop');
    const record = uuid ? await this.service.get(tenant, uuid) : null;
    return record ? toDrop(record) : null;
  }

  @Mutation(() => DropPayload, {
    description: 'Schedules a drop (ADR-820), on the Pro plan. Its drafts go on sale at its start.',
  })
  @RequireScopes('write_products')
  async dropCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: DropInput,
  ): Promise<DropPayload> {
    return payload(await this.service.set(tenant, null, valuesOf(input)));
  }

  @Mutation(() => DropPayload, {
    description: 'Changes a drop that has not ended, all of it.',
  })
  @RequireScopes('write_products')
  async dropUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: DropInput,
  ): Promise<DropPayload> {
    const uuid = tryFromPublicId(id, 'drop');
    return payload(await this.service.set(tenant, uuid ?? NO_PRODUCT, valuesOf(input)));
  }

  @Mutation(() => DropDeletePayload, {
    description:
      'Deletes a drop: its products sell as any others, and its drafts go on sale at no time.',
  })
  @RequireScopes('write_products')
  async dropDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DropDeletePayload> {
    const uuid = tryFromPublicId(id, 'drop');
    const deleted = uuid ? await this.service.delete(tenant, uuid) : false;
    return Object.assign(new DropDeletePayload(), { deletedId: deleted ? id : null });
  }
}

function valuesOf(input: DropInput) {
  return {
    name: input.name,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    productIds: input.productIds.map((id) => tryFromPublicId(id, 'product') ?? NO_PRODUCT),
    perCustomer: input.perCustomerLimit ?? null,
    admitPerMinute: input.admitPerMinute ?? null,
  };
}
