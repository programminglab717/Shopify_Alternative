import { CurrentTenant, Money, RequireScopes, type TenantContext } from '@hatti/api';
import { money } from '@hatti/money';
import { OrderService, TodayService, type OrderTally } from '@hatti/orders/public';
import {
  Field,
  GraphQLISODateTime,
  Int,
  ObjectType,
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
    "What waits for the shop, as the admin's home shows it first: orders to confirm, review, " +
    'see paid, pack and book, parcels coming back, lost parcels to claim and claims to follow ' +
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
    description: 'Refused or undeliverable parcels on their way back, to check in: RETURNING.',
  })
  returning!: HomeTally;

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
  ) {}

  @Query(() => Home, { description: "What waits for the shop: the admin's home." })
  @RequireScopes('read_orders')
  async home(@CurrentTenant() tenant: TenantContext): Promise<Home> {
    const home = await this.orders.home(tenant);
    const tally = (value: OrderTally) => homeTally(value, tenant);
    return Object.assign(new Home(), {
      toConfirm: tally(home.toConfirm),
      toReview: tally(home.toReview),
      awaitingPayment: tally(home.awaitingPayment),
      transfersToCheck: tally(home.transfersToCheck),
      toPack: tally(home.toPack),
      toBook: tally(home.toBook),
      returning: tally(home.returning),
      lostToClaim: tally(home.lostToClaim),
      claimsOpen: tally(home.claimsOpen),
      cashToCollect: tally(home.cashToCollect),
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
      delivered: tally(today.delivered),
      returnedToOrigin: tally(today.returnedToOrigin),
    });
  }
}

function homeTally(value: OrderTally, tenant: TenantContext): HomeTally {
  return Object.assign(new HomeTally(), {
    count: value.count,
    total: Money.from(money(value.total, tenant.currency)),
  });
}
