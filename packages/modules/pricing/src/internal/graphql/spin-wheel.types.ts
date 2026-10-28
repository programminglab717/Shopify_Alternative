import { Money, UserError } from '@hatti/api';
import {
  Field,
  Float,
  GraphQLISODateTime,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum SpinSliceKind {
  PERCENTAGE = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
  FREE_SHIPPING = 'FREE_SHIPPING',
  NONE = 'NONE',
}

registerEnumType(SpinSliceKind, {
  name: 'SpinSliceKind',
  description: "What a slice of the shop's wheel gives the shopper it stops for.",
  valuesMap: {
    PERCENTAGE: { description: "A code for a percentage off the order's items." },
    FIXED_AMOUNT: { description: "A code for an amount off the order's items." },
    FREE_SHIPPING: { description: 'A code for free delivery.' },
    NONE: { description: 'Nothing: "Better luck next time".' },
  },
});

@ObjectType()
export class SpinSlice {
  @Field({ description: 'The words on the wheel: "10% off".' })
  label!: string;

  @Field(() => SpinSliceKind)
  kind!: SpinSliceKind;

  @Field(() => Float, { nullable: true, description: 'Percent off, for a PERCENTAGE slice.' })
  percentage!: number | null;

  @Field(() => Money, { nullable: true, description: 'Off the items, for a FIXED_AMOUNT slice.' })
  amount!: Money | null;

  @Field(() => Int, {
    description: "How often the wheel stops at it, against the others' weights: 1 to 100.",
  })
  weight!: number;
}

@ObjectType({
  description:
    "Spin to win (OS-08): a wheel of offers on the shop's sign-up pop-up. A shopper gives their " +
    'number, is signed up for the shop\'s news and offers on WhatsApp, tagged "spin", and the ' +
    'wheel stops at a slice chosen by its weight; one that gives something is a code of their ' +
    'own, for one order. Once a number.',
})
export class SpinWheel {
  @Field({ description: "Whether the theme's sign-up pop-up shows it." })
  enabled!: boolean;

  @Field(() => [SpinSlice], { description: "2 to 8, in the wheel's order." })
  slices!: SpinSlice[];

  @Field(() => Int, { description: "How many days a shopper's code works: 1 to 90." })
  codeDays!: number;

  @Field(() => Money, {
    nullable: true,
    description: "What an order's items must come to for a code to work.",
  })
  minimumSubtotal!: Money | null;

  @Field(() => Int, { description: 'Numbers that have spun.' })
  spins!: number;

  @Field(() => Int, { description: 'Orders placed with codes the wheel gave.' })
  codesUsed!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  updatedAt!: Date | null;
}

@InputType()
export class SpinSliceInput {
  @Field({ description: 'The words on the wheel, up to 24 characters.' })
  label!: string;

  @Field(() => SpinSliceKind)
  kind!: SpinSliceKind;

  @Field(() => Float, {
    nullable: true,
    description: 'Percent off, 0.01 to 100, for a PERCENTAGE slice.',
  })
  percentage?: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'Off the items, in major units, for a FIXED_AMOUNT slice: "500".',
  })
  amount?: string | null;

  @Field(() => Int, { description: '1 to 100.' })
  weight!: number;
}

@InputType()
export class SpinWheelInput {
  @Field(() => Boolean, { nullable: true })
  enabled?: boolean | null;

  @Field(() => [SpinSliceInput], {
    nullable: true,
    description: 'Every slice, 2 to 8, in place of those it has.',
  })
  slices?: SpinSliceInput[] | null;

  @Field(() => Int, { nullable: true })
  codeDays?: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'In major units; null or blank for no minimum.',
  })
  minimumSubtotal?: string | null;
}

@ObjectType()
export class SpinWheelPayload {
  @Field(() => SpinWheel, { nullable: true })
  spinWheel!: SpinWheel | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
