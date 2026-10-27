import {
  CurrentTenant,
  Money,
  PublicSite,
  RequireScopes,
  UserError,
  deniedToRole,
  hasCapability,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  RIDER_LINK_PATH,
  RiderService,
  type DeliveryRecord,
  type DeliveryStatus,
  type RiderRecord,
} from '../riders.js';
import { uuidOf } from './couriers.resolver.js';
import {
  Rider,
  RiderDelivery,
  RiderDeliveryStatus,
  RiderHandOutPayload,
  RiderHandOutResult,
  RiderInput,
  RiderPayload,
} from './riders.types.js';

/** Riders are the shop's people: owners and managers, and custom roles that manage staff, keep them. */
function managesRiders(tenant: TenantContext): void {
  if (tenant.actor.kind === 'staff' && !hasCapability(tenant.actor, 'manage_staff')) {
    throw deniedToRole('Access denied. Only owners and managers add and change riders.');
  }
}

export function toRider(record: RiderRecord, currency: string): Rider {
  return Object.assign(new Rider(), {
    id: toPublicId('rider', record.id),
    name: record.name,
    phone: record.phone,
    active: record.active,
    out: record.out,
    cashHeld: Money.from(money(record.cashHeld, currency as CurrencyCode)),
    createdAt: record.createdAt,
  });
}

export function toRiderDelivery(record: DeliveryRecord, currency: string): RiderDelivery {
  const amount = (minor: bigint) => Money.from(money(minor, currency as CurrencyCode));
  return Object.assign(new RiderDelivery(), {
    id: toPublicId('riderDelivery', record.id),
    riderId: toPublicId('rider', record.riderId),
    orderId: toPublicId('order', record.orderId),
    fulfillmentId: toPublicId('fulfillment', record.fulfillmentId),
    status: record.status.toUpperCase() as RiderDeliveryStatus,
    cashDue: amount(record.cashDue),
    cashCollected: amount(record.cashCollected),
    codeSent: record.codeSent,
    codeGiven: record.codeGiven,
    failedReason: record.failedReason,
    deliveredAt: record.deliveredAt,
    failedAt: record.failedAt,
    createdAt: record.createdAt,
  });
}

/**
 * The shop's own riders (SHP-10, ADR-824): read by those who work orders; added, changed and
 * given new links by owners and managers; and packed orders handed to them by those who ship.
 */
@Resolver(() => Rider)
export class RiderResolver {
  constructor(
    private readonly service: RiderService,
    private readonly site: PublicSite,
  ) {}

  #payload(
    tenant: TenantContext,
    result: MutationResult<{ rider: RiderRecord; link: string | null }>,
  ): RiderPayload {
    return Object.assign(new RiderPayload(), {
      rider: result.ok ? toRider(result.value.rider, tenant.currency) : null,
      link:
        result.ok && result.value.link
          ? this.site.url(`/${RIDER_LINK_PATH}/${result.value.link}`)
          : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => [Rider], { description: "The shop's riders, by name, those who ride now first." })
  @RequireScopes('read_orders')
  async riders(@CurrentTenant() tenant: TenantContext): Promise<Rider[]> {
    return (await this.service.list(tenant)).map((rider) => toRider(rider, tenant.currency));
  }

  @Query(() => [RiderDelivery], {
    description: "The deliveries the shop's riders carried, the latest first: 100 at most.",
  })
  @RequireScopes('read_orders')
  async riderDeliveries(
    @CurrentTenant() tenant: TenantContext,
    @Args('riderId', { type: () => ID, nullable: true }) riderId?: string | null,
    @Args('status', { type: () => RiderDeliveryStatus, nullable: true })
    status?: RiderDeliveryStatus | null,
  ): Promise<RiderDelivery[]> {
    const deliveries = await this.service.deliveries(tenant, {
      riderId: riderId ? uuidOf('rider', riderId) : null,
      status: status ? (status.toLowerCase() as DeliveryStatus) : null,
    });
    return deliveries.map((delivery) => toRiderDelivery(delivery, tenant.currency));
  }

  @Mutation(() => RiderPayload, {
    description:
      "Adds a rider, with their page's link, given this once. Staff need to be an owner or a " +
      'manager.',
  })
  @RequireScopes('write_orders')
  async riderCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: RiderInput,
  ): Promise<RiderPayload> {
    managesRiders(tenant);
    return this.#payload(
      tenant,
      await this.service.create(tenant, { ...input, active: input.active ?? true }),
    );
  }

  @Mutation(() => RiderPayload, {
    description: "Changes a rider's name, number, or whether they ride for the shop now.",
  })
  @RequireScopes('write_orders')
  async riderUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: RiderInput,
  ): Promise<RiderPayload> {
    managesRiders(tenant);
    const result = await this.service.update(tenant, uuidOf('rider', id), {
      ...input,
      active: input.active ?? true,
    });
    return this.#payload(
      tenant,
      result.ok ? { ok: true, value: { rider: result.value, link: null } } : result,
    );
  }

  @Mutation(() => RiderPayload, {
    description: "A new link for a rider's page, given this once; the old one works no more.",
  })
  @RequireScopes('write_orders')
  async riderNewLink(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<RiderPayload> {
    managesRiders(tenant);
    const riderId = uuidOf('rider', id);
    const link = await this.service.newLink(tenant, riderId);
    if (!link.ok) return this.#payload(tenant, link);
    const rider = (await this.service.get(tenant, riderId))!;
    return this.#payload(tenant, { ok: true, value: { rider, link: link.value } });
  }

  @Mutation(() => RiderHandOutPayload, {
    description:
      'Hands packed orders to a rider who rides for the shop now, 50 at most, each on its own: ' +
      'shipped with them, everything left to ship in one parcel, its cash on delivery theirs to ' +
      'collect, and its customer sent a code on WhatsApp to give them at the door.',
  })
  @RequireScopes('write_orders')
  async riderHandOut(
    @CurrentTenant() tenant: TenantContext,
    @Args('riderId', { type: () => ID }) riderId: string,
    @Args('orderIds', { type: () => [ID] }) orderIds: string[],
  ): Promise<RiderHandOutPayload> {
    const result = await this.service.handOut(
      tenant,
      uuidOf('rider', riderId),
      orderIds.map((id) => uuidOf('order', id)),
    );
    return Object.assign(new RiderHandOutPayload(), {
      results: result.ok
        ? result.value.map((each) =>
            Object.assign(new RiderHandOutResult(), {
              orderId: toPublicId('order', each.orderId),
              delivery: 'delivery' in each ? toRiderDelivery(each.delivery, tenant.currency) : null,
              problem: 'problem' in each ? each.problem : null,
            }),
          )
        : [],
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
