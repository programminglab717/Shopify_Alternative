import { Money, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, InputType, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    'How many working days delivery takes (CHK-22): from `min` to `max`, 0 the same day.',
})
export class DeliveryDays {
  @Field(() => Int)
  min!: number;

  @Field(() => Int)
  max!: number;
}

@InputType()
export class DeliveryDaysInput {
  @Field(() => Int, { description: 'The fewest working days, 0 to 30; 0 is the same day.' })
  min!: number;

  @Field(() => Int, { description: 'The most, no fewer than `min`, up to 30.' })
  max!: number;
}

@ObjectType({ description: "Cities with a delivery charge of their own, such as the shop's own." })
export class DeliveryZone {
  @Field()
  name!: string;

  @Field(() => [String], { description: 'As addresses spell them, such as "Karachi".' })
  cities!: string[];

  @Field(() => Money)
  charge!: Money;

  @Field(() => DeliveryDays, {
    nullable: true,
    description: "How many working days delivery to its cities takes; null for everywhere's.",
  })
  days!: DeliveryDays | null;
}

@ObjectType({
  description:
    'What an order weighing more than `aboveGrams` costs more to deliver (CHK-04, ADR-702): ' +
    "the heaviest weight an order passes adds its charge to its city's.",
})
export class DeliveryWeight {
  @Field(() => Int, { description: 'In grams: 2000 for orders over 2 kg.' })
  aboveGrams!: number;

  @Field(() => Money)
  charge!: Money;
}

@InputType()
export class DeliveryWeightInput {
  @Field(() => Int, { description: 'Whole grams, 1 to 1,000,000: 2000 for orders over 2 kg.' })
  aboveGrams!: number;

  @Field(() => String, { description: 'Decimal, more than nothing, e.g. "150".' })
  charge!: string;
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

  @Field(() => DeliveryDays, {
    nullable: true,
    description:
      'How many working days delivery takes everywhere no zone says otherwise: the cart and ' +
      'product pages say how long delivery takes, and checkout says it for the city. Null while ' +
      'the shop has not said.',
  })
  days!: DeliveryDays | null;

  @Field(() => [DeliveryZone])
  zones!: DeliveryZone[];

  @Field(() => Int, {
    nullable: true,
    description:
      "The hour, 1 to 23 in Pakistan's time, from which the day's orders count their delivery " +
      'days from the next day, as they ship the day after (ADR-597); null for none.',
  })
  cutoffHour!: number | null;

  @Field(() => [DeliveryWeight], {
    description:
      'What heavier orders cost more, the lightest first: an order weighing more than one ' +
      "costs its charge more, the heaviest it passes alone, by its products' weights.",
  })
  weights!: DeliveryWeight[];

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

  @Field(() => DeliveryDaysInput, {
    nullable: true,
    description:
      "Its own working days, as the shop's own city's may be fewer; null for everywhere's.",
  })
  days?: DeliveryDaysInput | null;
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

  @Field(() => DeliveryDaysInput, {
    nullable: true,
    description: 'How many working days delivery takes everywhere; null to say nothing of it.',
  })
  days?: DeliveryDaysInput | null;

  @Field(() => [DeliveryZoneInput], {
    nullable: true,
    description: 'Replaces every zone; an empty list for none. Up to 20.',
  })
  zones?: DeliveryZoneInput[] | null;

  @Field(() => Int, {
    nullable: true,
    description: "The day's cut-off hour, 1 to 23 in Pakistan's time; null for none.",
  })
  cutoffHour?: number | null;

  @Field(() => [DeliveryWeightInput], {
    nullable: true,
    description: 'Replaces every weight, in any order; an empty list for none. Up to 10.',
  })
  weights?: DeliveryWeightInput[] | null;
}

@ObjectType()
export class DeliverySettingsUpdatePayload {
  @Field(() => DeliverySettings, { nullable: true })
  deliverySettings!: DeliverySettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
