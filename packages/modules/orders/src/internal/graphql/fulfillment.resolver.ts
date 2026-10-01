import {
  CurrentTenant,
  Loaders,
  Money,
  PageInfo,
  RequestLoaders,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  accessDenied,
  badUserInput,
  decodeCursor,
  deniedToRole,
  encodeCursor,
  hasScope,
  pageSize,
  type MutationResult,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import {
  Location,
  LocationService,
  toLocation,
  type LocationRecord,
} from '@hatti/inventory/public';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  FulfillmentService,
  type ClaimedParcelRecord,
  type LostParcelClaimFilter as LostParcelClaimFilterValue,
  type LostParcelRecord,
  type ParcelResult,
  type ReturningParcelRecord,
} from '../fulfillment.service.js';
import { orderName } from '../rules.js';
import type { ParcelClaimStatusValue } from '../schema.js';
import { toFulfillmentClaim, toOrder, uuidOf } from './mappers.js';
import {
  ClaimedParcel,
  ClaimedParcelConnection,
  ClaimedParcelEdge,
  Fulfillment,
  FulfillmentClaimCreatePayload,
  FulfillmentClaimSettlePayload,
  FulfillmentClaimSettlement,
  FulfillmentMarkDeliveredPayload,
  FulfillmentMarkLostPayload,
  FulfillmentMarkReturningPayload,
  FulfillmentReceiveReturnPayload,
  FulfillmentRestockInput,
  FulfillmentStatus,
  FulfillmentTrackingInfoUpdatePayload,
  FulfillmentTrackingInput,
  LostParcel,
  LostParcelConnection,
  LostParcelEdge,
  LostParcelsArgs,
  Order,
  OrderFulfillInput,
  OrderFulfillPayload,
  ParcelClaimsArgs,
  ReturningParcel,
  ReturningParcelConnection,
  ReturningParcelEdge,
  ReturningParcelsArgs,
  TrackingInfo,
} from './order.types.js';

type Payload = { fulfillment: Fulfillment | null; order: Order | null; userErrors: UserError[] };

/**
 * Staff who claim from couriers: owners, managers and accountants, who reconcile their cash
 * (ADR-093). Apps need write_orders.
 */
const CLAIMING_ROLES: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

function mayClaim(tenant: TenantContext): void {
  if (tenant.actor.kind === 'staff') {
    if (!CLAIMING_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole(
        'Access denied. Only owners, managers and accountants claim from couriers.',
      );
    }
  } else if (!hasScope(tenant, 'write_orders')) {
    throw accessDenied(['write_orders']);
  }
}

function payload<T extends Payload>(
  type: new () => T,
  result: MutationResult<ParcelResult>,
  tenant: TenantContext,
): T {
  if (!result.ok) {
    return Object.assign(new type(), {
      fulfillment: null,
      order: null,
      userErrors: UserError.list(result.errors),
    });
  }
  const order = toOrder(result.value.order, tenant);
  const id = toPublicId('fulfillment', result.value.fulfillmentId);
  return Object.assign(new type(), {
    fulfillment: order.fulfillments.find((parcel) => parcel.id === id) ?? null,
    order,
    userErrors: [],
  });
}

@Resolver(() => Fulfillment)
export class FulfillmentResolver {
  constructor(
    private readonly service: FulfillmentService,
    private readonly locations: LocationService,
  ) {}

  @ResolveField(() => Location, { nullable: true, description: 'Where it shipped from.' })
  async location(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() parcel: Fulfillment,
  ): Promise<Location | null> {
    const loader = loaders.get<string, LocationRecord>('inventory.locations', (ids) =>
      this.locations.getMany(tenant, ids),
    );
    const record = await loader.load(parcel.locationId);
    return record ? toLocation(record) : null;
  }

  @Mutation(() => OrderFulfillPayload, {
    description:
      'Ships items of a confirmed or prepaid order in one parcel, taking them out of stock. ' +
      'Needs an Idempotency-Key header.',
  })
  @RequireScopes('write_orders')
  @RequireIdempotencyKey()
  async orderFulfill(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { type: () => OrderFulfillInput, nullable: true })
    input?: OrderFulfillInput | null,
  ): Promise<OrderFulfillPayload> {
    const result = await this.service.fulfill(tenant, uuidOf('order', id), {
      lineItems: input?.lineItems?.map((line) => ({
        id: uuidOf('lineItem', line.id),
        quantity: line.quantity,
      })),
      tracking: input?.trackingInfo,
    });
    return payload(OrderFulfillPayload, result, tenant);
  }

  @Mutation(() => FulfillmentTrackingInfoUpdatePayload, {
    description: "Sets a parcel's courier, tracking number and link, e.g. once it is booked.",
  })
  @RequireScopes('write_orders')
  async fulfillmentTrackingInfoUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('trackingInfo', { type: () => FulfillmentTrackingInput })
    trackingInfo: FulfillmentTrackingInput,
  ): Promise<FulfillmentTrackingInfoUpdatePayload> {
    const result = await this.service.updateTracking(
      tenant,
      uuidOf('fulfillment', id),
      trackingInfo,
    );
    return payload(FulfillmentTrackingInfoUpdatePayload, result, tenant);
  }

  @Mutation(() => FulfillmentMarkDeliveredPayload, {
    description: 'The courier delivered the parcel.',
  })
  @RequireScopes('write_orders')
  async fulfillmentMarkDelivered(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FulfillmentMarkDeliveredPayload> {
    const result = await this.service.markDelivered(tenant, uuidOf('fulfillment', id));
    return payload(FulfillmentMarkDeliveredPayload, result, tenant);
  }

  @Mutation(() => FulfillmentMarkReturningPayload, {
    description:
      'The customer refused the parcel, or it could not be delivered: it is coming back.',
  })
  @RequireScopes('write_orders')
  async fulfillmentMarkReturning(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FulfillmentMarkReturningPayload> {
    const result = await this.service.markReturning(tenant, uuidOf('fulfillment', id));
    return payload(FulfillmentMarkReturningPayload, result, tenant);
  }

  @Mutation(() => FulfillmentMarkLostPayload, {
    description:
      'The courier lost the parcel, on its way out or back: its items are written off, and an ' +
      'order whose every parcel was lost is done, at the LOST stage. Lost before reaching the ' +
      'customer, it never counts as their refusal; refused first, it stays refused. Checked ' +
      'back in if it turns up.',
  })
  @RequireScopes('write_orders')
  async fulfillmentMarkLost(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FulfillmentMarkLostPayload> {
    const result = await this.service.markLost(tenant, uuidOf('fulfillment', id));
    return payload(FulfillmentMarkLostPayload, result, tenant);
  }

  @Mutation(() => FulfillmentClaimCreatePayload, {
    description:
      "Claims a lost parcel's worth from the courier that lost it, or what of a parcel that came " +
      "back was written off as damaged, or `amount`: the claim is the parcel's, OPEN until the " +
      'courier pays it, in a statement codRemittanceImport takes (for lost parcels) or ' +
      'otherwise, or refuses it, or the shop withdraws it (fulfillmentClaimSettle). A parcel has ' +
      'one claim, though one withdrawn may be filed again. Staff need to be an owner, a manager ' +
      'or an accountant.',
  })
  @RequireScopes('read_orders')
  async fulfillmentClaimCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('amount', {
      type: () => String,
      nullable: true,
      description:
        '"2500": what to claim, up to its order\'s total; the parcel\'s worth if left out.',
    })
    amount?: string | null,
    @Args('note', {
      type: () => String,
      nullable: true,
      description: "The courier's claim number, or anything else to keep: up to 500 characters.",
    })
    note?: string | null,
  ): Promise<FulfillmentClaimCreatePayload> {
    mayClaim(tenant);
    const result = await this.service.claim(tenant, uuidOf('fulfillment', id), { amount, note });
    return payload(FulfillmentClaimCreatePayload, result, tenant);
  }

  @Mutation(() => FulfillmentClaimSettlePayload, {
    description:
      "Records what became of a parcel's claim: PAID by the courier otherwise than in a " +
      'statement, with the amount; REFUSED, with why in the note; or WITHDRAWN by the shop. An ' +
      'open claim is settled so, and one refused may still be paid or withdrawn. Staff need to ' +
      'be an owner, a manager or an accountant.',
  })
  @RequireScopes('read_orders')
  async fulfillmentClaimSettle(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('status', { type: () => FulfillmentClaimSettlement })
    status: FulfillmentClaimSettlement,
    @Args('amount', {
      type: () => String,
      nullable: true,
      description: '"2500": what the courier paid, needed for PAID, up to its order\'s total.',
    })
    amount?: string | null,
    @Args('note', {
      type: () => String,
      nullable: true,
      description: "Why the courier refused it, or anything else; the claim's note if left out.",
    })
    note?: string | null,
  ): Promise<FulfillmentClaimSettlePayload> {
    mayClaim(tenant);
    const result = await this.service.settleClaim(tenant, uuidOf('fulfillment', id), {
      status: status.toLowerCase() as 'paid' | 'refused' | 'withdrawn',
      amount,
      note,
    });
    return payload(FulfillmentClaimSettlePayload, result, tenant);
  }

  @Mutation(() => FulfillmentReceiveReturnPayload, {
    description:
      'Checks a parcel that came back into its location: by its ID, or by the tracking number on ' +
      'its label, as a scanner reads it, spaces and letter case ignored. `restock` says how many ' +
      'of each line go back on the shelf; the rest are written off as damaged. Everything is ' +
      'restocked if left out.',
  })
  @RequireScopes('write_orders')
  async fulfillmentReceiveReturn(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('trackingNumber', {
      type: () => String,
      nullable: true,
      description: 'In place of `id`: one parcel still out must carry it.',
    })
    trackingNumber: string | null,
    @Args('restock', { type: () => [FulfillmentRestockInput], nullable: true })
    restock?: FulfillmentRestockInput[] | null,
  ): Promise<FulfillmentReceiveReturnPayload> {
    if (
      (id === null || id === undefined) ===
      (trackingNumber === null || trackingNumber === undefined)
    ) {
      return Object.assign(new FulfillmentReceiveReturnPayload(), {
        fulfillment: null,
        order: null,
        userErrors: UserError.list([
          {
            field: ['id'],
            code: 'INVALID',
            message: "Give the parcel's ID or its tracking number",
          },
        ]),
      });
    }
    const lines = restock?.map((entry) => ({
      lineItemId: uuidOf('lineItem', entry.lineItemId),
      quantity: entry.quantity,
    }));
    const result = id
      ? await this.service.receiveReturn(tenant, uuidOf('fulfillment', id), lines)
      : await this.service.receiveReturnByTracking(tenant, trackingNumber!, lines);
    return payload(FulfillmentReceiveReturnPayload, result, tenant);
  }

  @Query(() => ReturningParcelConnection, {
    description:
      'Parcels on their way back, refused or undeliverable, the longest on its way first, with ' +
      'how many days each has been: those a courier is slow to bring back, to chase.',
  })
  @RequireScopes('read_orders')
  async returningParcels(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ReturningParcelsArgs,
  ): Promise<ReturningParcelConnection> {
    const after = args.after ? timeCursor(args.after) : null;
    const { items, hasNextPage } = await this.service.returning(tenant, {
      first: pageSize(args.first),
      after: after && { id: after.id, returningAt: after.at },
      courier: args.courier,
    });
    const edges = items.map((record) =>
      Object.assign(new ReturningParcelEdge(), {
        node: toReturningParcel(record),
        cursor: encodeCursor({ id: record.id, at: record.returningAtExactly }),
      }),
    );
    return Object.assign(new ReturningParcelConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => LostParcelConnection, {
    description:
      'Parcels the courier lost, the longest lost first, with their worth and their claims: ' +
      'those not claimed yet and the claims still open are the ones to follow up.',
  })
  @RequireScopes('read_orders')
  async lostParcels(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: LostParcelsArgs,
  ): Promise<LostParcelConnection> {
    const after = args.after ? timeCursor(args.after) : null;
    const { items, hasNextPage } = await this.service.lost(tenant, {
      first: pageSize(args.first),
      after: after && { id: after.id, lostAt: after.at },
      courier: args.courier,
      claims: args.claim?.map((claim) => claim.toLowerCase() as LostParcelClaimFilterValue) ?? null,
    });
    const edges = items.map((record) =>
      Object.assign(new LostParcelEdge(), {
        node: toLostParcel(record, tenant.currency),
        cursor: encodeCursor({ id: record.id, at: record.lostAtExactly }),
      }),
    );
    return Object.assign(new LostParcelConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => ClaimedParcelConnection, {
    description:
      'Parcels with claims on their couriers, lost or come back damaged, the oldest claim ' +
      'first: those still open, or refused, are the ones to follow up.',
  })
  @RequireScopes('read_orders')
  async parcelClaims(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ParcelClaimsArgs,
  ): Promise<ClaimedParcelConnection> {
    const after = args.after ? timeCursor(args.after) : null;
    const { items, hasNextPage } = await this.service.claims(tenant, {
      first: pageSize(args.first),
      after: after && { id: after.id, claimedAt: after.at },
      courier: args.courier,
      statuses:
        args.status?.map((status) => status.toLowerCase() as ParcelClaimStatusValue) ?? null,
    });
    const edges = items.map((record) =>
      Object.assign(new ClaimedParcelEdge(), {
        node: toClaimedParcel(record, tenant.currency),
        cursor: encodeCursor({ id: record.id, at: record.claimedAtExactly }),
      }),
    );
    return Object.assign(new ClaimedParcelConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }
}

/** A time to the microsecond, as the cursors of lists in time order carry it. */
const EXACT_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

/** Where the previous page of a list in time order ended: a parcel's ID and its time. */
function timeCursor(after: string): { id: string; at: string } {
  const { id, at } = decodeCursor(after, ['id', 'at']);
  // A time the database reads as it is written: no 31st of February.
  const time = EXACT_TIME.exec(at);
  const real =
    time !== null && Date.parse(at) > 0 && new Date(at).toISOString().startsWith(time[1]!);
  if (!isUuid(id) || !real) throw badUserInput('Invalid cursor');
  return { id, at };
}

function toClaimedParcel(record: ClaimedParcelRecord, currency: CurrencyCode): ClaimedParcel {
  return Object.assign(new ClaimedParcel(), {
    id: toPublicId('fulfillment', record.id),
    orderId: toPublicId('order', record.orderId),
    orderName: orderName(record.orderNumber),
    status: record.status.toUpperCase() as FulfillmentStatus,
    trackingInfo: Object.assign(new TrackingInfo(), {
      company: record.trackingCompany,
      number: record.trackingNumber,
      url: record.trackingUrl,
    }),
    claim: toFulfillmentClaim(record.claim, currency),
  });
}

function toLostParcel(record: LostParcelRecord, currency: CurrencyCode): LostParcel {
  return Object.assign(new LostParcel(), {
    id: toPublicId('fulfillment', record.id),
    orderId: toPublicId('order', record.orderId),
    orderName: orderName(record.orderNumber),
    trackingInfo: Object.assign(new TrackingInfo(), {
      company: record.trackingCompany,
      number: record.trackingNumber,
      url: record.trackingUrl,
    }),
    shippedAt: record.shippedAt,
    lostAt: record.lostAt,
    days: record.days,
    units: record.units,
    worth: Money.from(money(record.worth, currency)),
    claim: record.claim && toFulfillmentClaim(record.claim, currency),
  });
}

function toReturningParcel(record: ReturningParcelRecord): ReturningParcel {
  return Object.assign(new ReturningParcel(), {
    id: toPublicId('fulfillment', record.id),
    orderId: toPublicId('order', record.orderId),
    orderName: orderName(record.orderNumber),
    trackingInfo: Object.assign(new TrackingInfo(), {
      company: record.trackingCompany,
      number: record.trackingNumber,
      url: record.trackingUrl,
    }),
    shippedAt: record.shippedAt,
    returningAt: record.returningAt,
    days: record.days,
    units: record.units,
  });
}
