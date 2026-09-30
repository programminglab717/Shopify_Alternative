import { Money, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: "Cities with a delivery charge of their own, such as the shop's own." })
export class DeliveryZone {
  @Field()
  name!: string;

  @Field(() => [String], { description: 'As addresses spell them, such as "Karachi".' })
  cities!: string[];

  @Field(() => Money)
  charge!: Money;
}

@ObjectType({
  description: 'What the shop charges to deliver an order, which checkout adds for its city.',
})
export class DeliverySettings {
  @Field(() => Money, { description: 'For everywhere no zone names. Nothing unless set.' })
  charge!: Money;

  @Field(() => Money, {
    nullable: true,
    description: 'Delivery is free for a subtotal of this or more; null for never.',
  })
  freeAbove!: Money | null;

  @Field(() => [DeliveryZone])
  zones!: DeliveryZone[];

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'null while the shop has set none.',
  })
  updatedAt!: Date | null;
}

@InputType()
export class DeliveryZoneInput {
  @Field()
  name!: string;

  @Field(() => [String], {
    description:
      'Cities by name, alias or code, as addresses have them: "Karachi", "khi", "Pindi". A city ' +
      'is in one zone at most.',
  })
  cities!: string[];

  @Field(() => String, { description: 'Decimal, e.g. "150".' })
  charge!: string;
}

@InputType({ description: 'Those not given stay as they are.' })
export class DeliverySettingsUpdateInput {
  @Field(() => String, { nullable: true, description: 'Decimal, e.g. "250"; null for nothing.' })
  charge?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Decimal, e.g. "5,000"; null or blank for no free delivery.',
  })
  freeAbove?: string | null;

  @Field(() => [DeliveryZoneInput], {
    nullable: true,
    description: 'Replaces every zone; an empty list for none. Up to 20.',
  })
  zones?: DeliveryZoneInput[] | null;
}

@ObjectType()
export class DeliverySettingsUpdatePayload {
  @Field(() => DeliverySettings, { nullable: true })
  deliverySettings!: DeliverySettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
