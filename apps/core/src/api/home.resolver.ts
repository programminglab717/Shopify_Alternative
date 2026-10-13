import { CurrentTenant, Money, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import { LowStockService, TransferService } from '@hatti/inventory/public';
import { CourierPickupService } from '@hatti/logistics/public';
import { money } from '@hatti/money';
import {
  DeliveryRescueService,
  OrderService,
  TodayService,
  type OrderTally,
} from '@hatti/orders/public';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';

@ObjectType({ description: 'How many orders or parcels, and what they come to.' })
export class HomeTally {
  @Field(() => Int)
  count!: number;

  @Field(() => Money)
  total!: Money;
}

@ObjectType({
  description:
    "How the shop's day has gone so far, in its time zone from its midnight, as the admin's " +
    'home shows it (ANL-01).',
})
export class HomeToday {
  @Field(() => GraphQLISODateTime, {
    description: "When today began: midnight in the shop's time zone.",
  })
  since!: Date;

  @Field(() => HomeTally, {
    description:
      'Orders placed today, cancelled ones aside, and their total sales: what salesReport gives ' +
      'for today, net sales with shipping, fees and taxes.',
  })
  sales!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'The same of yesterday until this time of day, to compare with (ADR-250): orders placed ' +
      "from yesterday's midnight for as long as today has gone, and their total sales.",
  })
  salesYesterday!: HomeTally;

  @Field(() => HomeTally, {
    description: 'Parcels delivered today, and their worth: their items at the prices sold.',
  })
  delivered!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'Parcels their couriers turned back today, refused or undeliverable (RTO), and their ' +
      'worth; on their way back or checked in since.',
  })
  returnedToOrigin!: HomeTally;
}

@ObjectType({
  description:
    "How many of the shop's variants of active products run low on stock, and how many are " +
    'out, at its threshold (INV-01).',
})
export class HomeStock {
  @Field(() => Int, {
    description: 'What the shop calls low: this many units for sale online, or fewer.',
  })
  threshold!: number;

  @Field(() => Int, {
    description: 'With some for sale, the threshold or fewer: inventoryLowStock lists them.',
  })
  low!: number;

  @Field(() => Int, { description: 'With none for sale.' })
  out!: number;
}

@ObjectType({
  description:
    "What waits for the shop, as the admin's home shows it first: orders to confirm, review, " +
    'see paid, pack and book, parcels and returns coming back, lost parcels to claim and claims to follow ' +
    'up, and the cash on delivery still to come; and how today has gone (ANL-01).',
})
export class Home {
  @Field(() => HomeTally, {
    description:
      'Cash-on-delivery orders waiting for their customers to confirm: NEEDS_CONFIRMATION.',
  })
  toConfirm!: HomeTally;

  @Field(() => HomeTally, {
    description: 'Held for staff, for a blocked number or a risk score: NEEDS_REVIEW.',
  })
  toReview!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'Paid by bank transfer, with money staff have not seen yet, to look for in the ' +
      "shop's account: AWAITING_PAYMENT.",
  })
  awaitingPayment!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'Of those awaiting payment, the orders whose customers sent a receipt for their transfer, ' +
      "to check against the shop's account first: orders(stage: AWAITING_PAYMENT, " +
      'hasTransferReceipt: true).',
  })
  transfersToCheck!: HomeTally;

  @Field(() => HomeTally, { description: 'Confirmed or paid, to pack: TO_PACK.' })
  toPack!: HomeTally;

  @Field(() => HomeTally, { description: 'Packed, for a courier to take: TO_BOOK.' })
  toBook!: HomeTally;

  @Field(() => HomeTally, {
    description: 'Packed, for their customers to collect (SHP-15, ADR-389): READY_FOR_PICKUP.',
  })
  readyForPickup!: HomeTally;

  @Field(() => HomeTally, {
    description: 'Refused or undeliverable parcels on their way back, to check in: RETURNING.',
  })
  returning!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'Customer returns on their way, to check in, and what their items sold for: openReturns ' +
      '(ADR-138).',
  })
  returnsToReceive!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'Parcels the courier lost that the shop has not claimed from it yet, and their worth: ' +
      'lostParcels(claim: UNCLAIMED).',
  })
  lostToClaim!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'Claims on couriers they have neither paid nor refused yet, for parcels they lost or that ' +
      'came back damaged, and what they claim: parcelClaims(status: OPEN).',
  })
  claimsOpen!: HomeTally;

  @Field(() => HomeTally, {
    description:
      'Cash on delivery not yet received, on parcels on their way and on delivered orders not ' +
      'yet marked paid: its total is the cash still to come, not what the orders come to.',
  })
  cashToCollect!: HomeTally;

  /** The location the home was asked for, if one: what its fields count. */
  locationId!: string | null;
}

/**
 * The admin's home (ANL-01): what waits for the shop, from the orders' stages, and how today has
 * gone, worked out only when asked for.
 */
@Resolver(() => Home)
export class HomeResolver {
  constructor(
    private readonly orders: OrderService,
    private readonly days: TodayService,
    private readonly stock: LowStockService,
    private readonly transfers: TransferService,
    private readonly pickups: CourierPickupService,
    private readonly rescue: DeliveryRescueService,
  ) {}

  @Query(() => Home, { description: "What waits for the shop: the admin's home." })
  @RequireScopes('read_orders')
  async home(
    @CurrentTenant() tenant: TenantContext,
    @Args('locationId', {
      type: () => ID,
      nullable: true,
      description:
        'What waits at this location alone: the orders shipping from it, their parcels and ' +
        "returns. Today's figures and low stock stay the shop's.",
    })
    locationId: string | null,
  ): Promise<Home> {
    const location = locationId ? locationUuid(locationId) : null;
    const home = await this.orders.home(tenant, { locationId: location });
    const tally = (value: OrderTally) => homeTally(value, tenant);
    return Object.assign(new Home(), {
      toConfirm: tally(home.toConfirm),
      toReview: tally(home.toReview),
      awaitingPayment: tally(home.awaitingPayment),
      transfersToCheck: tally(home.transfersToCheck),
      toPack: tally(home.toPack),
      toBook: tally(home.toBook),
      readyForPickup: tally(home.readyForPickup),
      returning: tally(home.returning),
      returnsToReceive: tally(home.returnsToReceive),
      lostToClaim: tally(home.lostToClaim),
      claimsOpen: tally(home.claimsOpen),
      cashToCollect: tally(home.cashToCollect),
      locationId: location,
    });
  }

  @ResolveField(() => HomeToday, {
    description:
      "How today has gone, in the shop's time zone: sales, and parcels delivered and turned back " +
      '(ADR-121).',
  })
  async today(@CurrentTenant() tenant: TenantContext): Promise<HomeToday> {
    const today = await this.days.today(tenant);
    const tally = (value: OrderTally) => homeTally(value, tenant);
    return Object.assign(new HomeToday(), {
      since: today.since,
      sales: tally(today.sales),
      salesYesterday: tally(today.salesYesterday),
      delivered: tally(today.delivered),
      returnedToOrigin: tally(today.returnedToOrigin),
    });
  }

  @ResolveField(() => HomeStock, {
    description:
      'Variants running low or out of stock, worked out when asked for (ADR-125); needs ' +
      'read_inventory.',
  })
  @RequireScopes('read_inventory')
  async lowStock(@CurrentTenant() tenant: TenantContext): Promise<HomeStock> {
    return Object.assign(new HomeStock(), await this.stock.counts(tenant));
  }

  @ResolveField(() => Int, {
    description:
      "Transfers of stock on their way between the shop's locations, to receive (ADR-364): " +
      'those going to the location asked for, or every one; needs read_inventory.',
  })
  @RequireScopes('read_inventory')
  async transfersToReceive(
    @CurrentTenant() tenant: TenantContext,
    @Parent() home: Home,
  ): Promise<number> {
    return this.transfers.countInTransit(tenant, home.locationId);
  }

  @ResolveField(() => Int, {
    description:
      "Parcels handed to a courier's rider a day ago and more that the courier's tracking still " +
      'has as only booked (ADR-379, ADR-380): the rider may never have scanned them in, or lost ' +
      'them; courierParcelsUnseen lists them.',
  })
  async parcelsUnseen(@CurrentTenant() tenant: TenantContext): Promise<number> {
    return this.pickups.unseenCount(tenant);
  }

  @ResolveField(() => Int, {
    description:
      'Parcels on their way whose last step is a failed delivery (COD-08, ADR-388), to rescue ' +
      'before their couriers send them back; deliveriesToRescue lists them.',
  })
  async deliveriesToRescue(@CurrentTenant() tenant: TenantContext): Promise<number> {
    return (await this.rescue.list(tenant, 0)).count;
  }
}

function homeTally(value: OrderTally, tenant: TenantContext): HomeTally {
  return Object.assign(new HomeTally(), {
    count: value.count,
    total: Money.from(money(value.total, tenant.currency)),
  });
}

/** A location's UUID from its public ID, or a BAD_USER_INPUT error. */
function locationUuid(id: string): string {
  const uuid = tryFromPublicId(id, 'location');
  if (!uuid) throw badUserInput(`Invalid location id: ${id.slice(0, 64)}`);
  return uuid;
}
