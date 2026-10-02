import {
  CurrentTenant,
  Money,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Inject } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  CourierBookingService,
  type BookingStatusValue,
  type CourierBookingRecord,
} from '../bookings.service.js';
import {
  COURIERS,
  CourierAccountService,
  type CourierAccountRecord,
} from '../courier-accounts.service.js';
import type { Couriers, CourierParcelStatusValue } from '../couriers.js';
import {
  Courier,
  CourierAccount,
  CourierAccountInput,
  CourierAccountPayload,
  CourierBooking,
  CourierBookingConnection,
  CourierBookingEdge,
  CourierBookingPayload,
  CourierBookingStatus,
  CourierBookingsArgs,
  CourierParcelStatus,
  OrderBookingRefusal,
  OrdersBookPayload,
} from './couriers.types.js';

/**
 * Couriers, the shop's accounts with them, and its orders' bookings (SHP-01, SHP-02, SHP-04,
 * ADR-149). Accounts are shop settings: owners and managers connect them, and apps with
 * write_settings. Booking orders is orders' work, packers' included.
 */
@Resolver(() => CourierBooking)
export class CourierResolver {
  constructor(
    private readonly accounts: CourierAccountService,
    private readonly bookings: CourierBookingService,
    @Inject(COURIERS) private readonly catalog: Couriers,
  ) {}

  @Query(() => [Courier], { description: 'The couriers shops book parcels with here.' })
  @RequireScopes('read_orders')
  couriers(): Courier[] {
    return this.catalog.list.map((info) =>
      Object.assign(new Courier(), {
        courier: info.courier,
        name: info.name,
        credentials: info.credentials.map((field) => ({ key: field.key, label: field.label })),
        pickupCode: info.pickupCode,
        test: info.test,
      }),
    );
  }

  @Query(() => [CourierAccount], {
    description: "The shop's courier accounts, the default first; archived ones if asked.",
  })
  @RequireScopes('read_orders')
  async courierAccounts(
    @CurrentTenant() tenant: TenantContext,
    @Args('archived', { type: () => Boolean, nullable: true }) archived?: boolean | null,
  ): Promise<CourierAccount[]> {
    const records = await this.accounts.list(tenant, { archived: archived ?? false });
    return records.map(toAccount);
  }

  @Mutation(() => CourierAccountPayload, {
    description:
      "Connects the shop's own account with a courier, with the credentials its portal gives, " +
      "kept sealed and never shown again. The shop's first account is its default.",
  })
  @RequireScopes('write_settings')
  async courierAccountConnect(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CourierAccountInput,
  ): Promise<CourierAccountPayload> {
    return accountPayload(await this.accounts.connect(tenant, input));
  }

  @Mutation(() => CourierAccountPayload, {
    description:
      'Changes a courier account: its name, credentials, pickup code, or makes it the default.',
  })
  @RequireScopes('write_settings')
  async courierAccountUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: CourierAccountInput,
  ): Promise<CourierAccountPayload> {
    return accountPayload(await this.accounts.update(tenant, uuidOf('courierAccount', id), input));
  }

  @Mutation(() => CourierAccountPayload, {
    description:
      'Archives a courier account: no more bookings with it, and its bookings waiting are ' +
      'cancelled; its parcels are still followed. The default passes to the oldest left.',
  })
  @RequireScopes('write_settings')
  async courierAccountArchive(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CourierAccountPayload> {
    return accountPayload(await this.accounts.archive(tenant, uuidOf('courierAccount', id)));
  }

  @Mutation(() => OrdersBookPayload, {
    description:
      'Books up to 250 orders with a courier account, the default unless given, each on its ' +
      "own: each waits to be booked, then ships as a parcel with the courier's tracking number, " +
      'and is followed until it is delivered or back. The courier collects what the order owes. ' +
      'Orders that cannot ship now, are booked already, or have part shipped are refused, each ' +
      'with why.',
  })
  @RequireScopes('write_orders')
  async ordersBook(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('accountId', { type: () => ID, nullable: true }) accountId?: string | null,
  ): Promise<OrdersBookPayload> {
    const result = await this.bookings.request(tenant, {
      orderIds: ids.map((id) => uuidOf('order', id)),
      accountId: accountId ? uuidOf('courierAccount', accountId) : null,
    });
    return Object.assign(new OrdersBookPayload(), {
      bookings: result.ok
        ? result.value.bookings.map((record) => toBooking(record, tenant.currency))
        : [],
      refused: result.ok
        ? result.value.refused.map((refusal) =>
            Object.assign(new OrderBookingRefusal(), {
              orderId: toPublicId('order', refusal.orderId),
              message: refusal.message,
            }),
          )
        : [],
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => CourierBookingConnection, {
    description: "The shop's bookings with couriers, the latest first.",
  })
  @RequireScopes('read_orders')
  async courierBookings(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CourierBookingsArgs,
  ): Promise<CourierBookingConnection> {
    const cursor = args.after ? decodeCursor(args.after, ['id', 'at']) : null;
    const { items, hasNextPage } = await this.bookings.list(tenant, {
      first: pageSize(args.first),
      after: cursor && { id: uuidOf('courierBooking', cursor.id), createdAt: cursor.at },
      status: args.status ? (args.status.toLowerCase() as BookingStatusValue) : null,
      orderId: args.orderId ? uuidOf('order', args.orderId) : null,
    });
    const edges = items.map((record) =>
      Object.assign(new CourierBookingEdge(), {
        cursor: encodeCursor({
          id: toPublicId('courierBooking', record.id),
          at: record.createdAtExactly,
        }),
        node: toBooking(record, tenant.currency),
      }),
    );
    return Object.assign(new CourierBookingConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => CourierBooking, { nullable: true })
  @RequireScopes('read_orders')
  async courierBooking(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CourierBooking | null> {
    const record = await this.bookings.get(tenant, uuidOf('courierBooking', id));
    return record && toBooking(record, tenant.currency);
  }

  @Mutation(() => CourierBookingPayload, {
    description:
      'Cancels a booking while it waits. One booked is cancelled with the courier, not here.',
  })
  @RequireScopes('write_orders')
  async courierBookingCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CourierBookingPayload> {
    const result = await this.bookings.cancel(tenant, uuidOf('courierBooking', id));
    return Object.assign(new CourierBookingPayload(), {
      courierBooking: result.ok ? toBooking(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

function accountPayload(result: MutationResult<CourierAccountRecord>): CourierAccountPayload {
  return Object.assign(new CourierAccountPayload(), {
    courierAccount: result.ok ? toAccount(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

function toAccount(record: CourierAccountRecord): CourierAccount {
  return Object.assign(new CourierAccount(), {
    ...record,
    id: toPublicId('courierAccount', record.id),
  });
}

function toBooking(record: CourierBookingRecord, currency: CurrencyCode): CourierBooking {
  return Object.assign(new CourierBooking(), {
    id: toPublicId('courierBooking', record.id),
    orderId: toPublicId('order', record.orderId),
    orderName: `#${record.orderNumber}`,
    accountId: toPublicId('courierAccount', record.accountId),
    courierName: record.courierName,
    status: record.status.toUpperCase() as CourierBookingStatus,
    attempts: record.attempts,
    error: record.error,
    trackingNumber: record.trackingNumber,
    codAmount: record.codAmount === null ? null : Money.from(money(record.codAmount, currency)),
    fulfillmentId: record.fulfillmentId && toPublicId('fulfillment', record.fulfillmentId),
    courierStatus: record.courierStatus,
    parcelStatus: record.parcelStatus && toParcelStatus(record.parcelStatus),
    trackedAt: record.trackedAt,
    bookedAt: record.bookedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toParcelStatus(status: CourierParcelStatusValue): CourierParcelStatus {
  return status.toUpperCase() as CourierParcelStatus;
}
