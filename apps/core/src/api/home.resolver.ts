import { CurrentTenant, Money, RequireScopes, type TenantContext } from '@hatti/api';
import { money } from '@hatti/money';
import { OrderService, type OrderTally } from '@hatti/orders/public';
import { Field, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';

@ObjectType({ description: 'How many orders, and what they come to.' })
export class HomeTally {
  @Field(() => Int)
  count!: number;

  @Field(() => Money)
  total!: Money;
}

@ObjectType({
  description:
    "What waits for the shop, as the admin's home shows it first: orders to confirm, review, " +
    'see paid, pack and book, parcels coming back, and the cash on delivery still to come ' +
    '(ANL-01).',
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
      'Cash on delivery not yet received, on parcels on their way and on delivered orders not ' +
      'yet marked paid: its total is the cash still to come, not what the orders come to.',
  })
  cashToCollect!: HomeTally;
}

/** The admin's home (ANL-01): what waits for the shop, from the orders' stages. */
@Resolver()
export class HomeResolver {
  constructor(private readonly orders: OrderService) {}

  @Query(() => Home, { description: "What waits for the shop: the admin's home." })
  @RequireScopes('read_orders')
  async home(@CurrentTenant() tenant: TenantContext): Promise<Home> {
    const home = await this.orders.home(tenant);
    const tally = (value: OrderTally) =>
      Object.assign(new HomeTally(), {
        count: value.count,
        total: Money.from(money(value.total, tenant.currency)),
      });
    return Object.assign(new Home(), {
      toConfirm: tally(home.toConfirm),
      toReview: tally(home.toReview),
      awaitingPayment: tally(home.awaitingPayment),
      toPack: tally(home.toPack),
      toBook: tally(home.toBook),
      returning: tally(home.returning),
      cashToCollect: tally(home.cashToCollect),
    });
  }
}
