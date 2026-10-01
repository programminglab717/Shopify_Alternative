import { Money } from '@hatti/api';
import { Field, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'Orders, and the cash on delivery they still owe the shop.' })
export class CodCash {
  @Field(() => Int)
  count!: number;

  @Field(() => Money)
  amount!: Money;
}

@ObjectType({
  description: 'Cash owed on parcels delivered between fromDays and toDays days ago, whole days.',
})
export class CodReceivableAge {
  @Field(() => Int)
  fromDays!: number;

  @Field(() => Int, { nullable: true, description: 'None for the oldest: it has no end.' })
  toDays!: number | null;

  @Field(() => Int)
  count!: number;

  @Field(() => Money)
  amount!: Money;
}

@ObjectType({ description: 'The cash on delivery one courier holds for the shop.' })
export class CourierReceivables {
  @Field(() => String, {
    nullable: true,
    description:
      'The courier as staff named it when shipping, in any letter case; none for parcels ' +
      'shipped without a courier named.',
  })
  courier!: string | null;

  @Field(() => CodCash)
  owed!: CodCash;

  @Field(() => [CodReceivableAge], { description: 'Every age, oldest last.' })
  ages!: CodReceivableAge[];

  @Field(() => GraphQLISODateTime, {
    description: 'When the parcel whose cash has waited longest was delivered.',
  })
  oldestDeliveredAt!: Date;
}

@ObjectType({
  description:
    'The cash on delivery couriers hold for the shop (COD-10): on delivered orders not yet ' +
    'paid, what they still owe, by courier and by days since delivery; and what is on its way. ' +
    "Owed and on its way together are the home's cashToCollect.",
})
export class CodReceivables {
  @Field(() => CodCash, { description: 'Delivered, and not yet received: what couriers owe.' })
  owed!: CodCash;

  @Field(() => [CodReceivableAge], { description: 'What couriers owe, by age, oldest last.' })
  ages!: CodReceivableAge[];

  @Field(() => CodCash, { description: 'On parcels still on their way, not yet collected.' })
  onTheWay!: CodCash;

  @Field(() => [CourierReceivables], { description: 'The courier owing most first.' })
  couriers!: CourierReceivables[];
}
