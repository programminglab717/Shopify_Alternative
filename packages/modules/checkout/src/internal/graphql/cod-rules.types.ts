import { Money, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, InputType, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    "The shop's rules for cash on delivery at checkout (CHK-07): where they keep it from an " +
    "order, checkout offers bank transfer instead, or says why it can't take the order. Orders " +
    "staff and apps place are the shop's own call, and keep to the law's cap alone.",
})
export class CashOnDeliverySettings {
  @Field(() => Money, {
    nullable: true,
    description:
      "No cash on delivery for orders above it; null for no limit but the law's, Rs 200,000.",
  })
  maxOrderTotal!: Money | null;

  @Field(() => [String], {
    description: 'Cities where checkout doesn\'t offer it, as addresses spell them: "Gilgit".',
  })
  unavailableCities!: string[];

  @Field(() => Int, {
    nullable: true,
    description:
      'Customers who refused this many parcels before, or more, pay another way; null for no ' +
      'limit. Their delivery history counts them: refused or undeliverable, coming back or back.',
  })
  refusedDeliveriesLimit!: number | null;

  @Field(() => Money, {
    description:
      'What an order paid on delivery is charged for it (CHK-08): checkout adds it, and the ' +
      'order keeps it apart from delivery. Nothing unless set.',
  })
  fee!: Money;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'null while the shop has set none.',
  })
  updatedAt!: Date | null;
}

@InputType({ description: 'Those not given stay as they are.' })
export class CashOnDeliverySettingsInput {
  @Field(() => String, {
    nullable: true,
    description: 'Decimal, e.g. "25,000"; null or blank for no limit but the law\'s.',
  })
  maxOrderTotal?: string | null;

  @Field(() => [String], {
    nullable: true,
    description:
      'Replaces them all; an empty list for none. Cities by name, alias or code, as addresses ' +
      'have them: "Gilgit", "isb". Up to 200.',
  })
  unavailableCities?: string[] | null;

  @Field(() => Int, { nullable: true, description: '1 to 100; null for no limit.' })
  refusedDeliveriesLimit?: number | null;

  @Field(() => String, { nullable: true, description: 'Decimal, e.g. "100"; null for nothing.' })
  fee?: string | null;
}

@ObjectType()
export class CashOnDeliverySettingsUpdatePayload {
  @Field(() => CashOnDeliverySettings, { nullable: true })
  cashOnDeliverySettings!: CashOnDeliverySettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
