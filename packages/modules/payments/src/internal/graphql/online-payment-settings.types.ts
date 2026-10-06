import { Money, UserError } from '@hatti/api';
import {
  Field,
  Float,
  GraphQLISODateTime,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum OnlinePaymentDiscountKind {
  PERCENTAGE = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
}

registerEnumType(OnlinePaymentDiscountKind, {
  name: 'OnlinePaymentDiscountKind',
  description: 'What paying online takes off.',
  valuesMap: {
    PERCENTAGE: { description: "A percentage of the order's items, up to a cap if one is set." },
    FIXED_AMOUNT: { description: "An amount off the order's items." },
  },
});

@ObjectType({
  description:
    "What checkout takes off orders paid online, as the shop's prepaid incentive (PAY-05, " +
    "ADR-222): off the order's items after any discount code, as for paying by bank transfer. " +
    'The order keeps it in totalDiscounts, and apart as onlineDiscount.',
})
export class OnlinePaymentDiscount {
  @Field(() => OnlinePaymentDiscountKind)
  kind!: OnlinePaymentDiscountKind;

  @Field(() => Float, {
    nullable: true,
    description: "Percent off the order's items, for PERCENTAGE: 5 is 5%.",
  })
  percentage!: number | null;

  @Field(() => Money, {
    nullable: true,
    description: 'The most a PERCENTAGE takes off an order; null for no cap.',
  })
  cap!: Money | null;

  @Field(() => Money, {
    nullable: true,
    description: "Off the order's items, for FIXED_AMOUNT, never more than they come to.",
  })
  amount!: Money | null;
}

@ObjectType({
  description: "How the shop's customers pay online, beside its payment gateway accounts (PAY-05).",
})
export class OnlinePaymentSettings {
  @Field(() => OnlinePaymentDiscount, {
    nullable: true,
    description:
      'What checkout takes off orders paid online, while the shop takes payments online; null ' +
      'for nothing.',
  })
  discount!: OnlinePaymentDiscount | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last changed them; none while it never has.',
  })
  updatedAt!: Date | null;
}

@InputType({
  description: 'A percentage off, with a cap or not, or an amount off: one of the two.',
})
export class OnlinePaymentDiscountInput {
  @Field(() => Float, {
    nullable: true,
    description:
      "Percent off the order's items after any discount code, 0.01 to 50, with two decimals " +
      'at most.',
  })
  percentage?: number | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The most a percentage takes off an order, in the shop currency: "500". Blank for no cap.',
  })
  cap?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'An amount off the order\'s items after any discount code, in the shop currency: "150".',
  })
  amount?: string | null;
}

@InputType()
export class OnlinePaymentSettingsInput {
  @Field(() => OnlinePaymentDiscountInput, {
    nullable: true,
    description:
      'Replaces what checkout takes off orders paid online. null takes it away; orders placed ' +
      'before keep theirs.',
  })
  discount?: OnlinePaymentDiscountInput | null;
}

@ObjectType()
export class OnlinePaymentSettingsUpdatePayload {
  @Field(() => OnlinePaymentSettings, { nullable: true })
  onlinePaymentSettings!: OnlinePaymentSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
