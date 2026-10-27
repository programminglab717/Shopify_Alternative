import { Money, UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum ReferralOutcome {
  REWARDED = 'REWARDED',
  REFUSED = 'REFUSED',
}

registerEnumType(ReferralOutcome, {
  name: 'ReferralOutcome',
  description: 'What became of a referral (MKT-07, ADR-807).',
});

export enum ReferralRefusal {
  OWN_CODE = 'OWN_CODE',
  NOT_FIRST_ORDER = 'NOT_FIRST_ORDER',
  SAME_DEVICE = 'SAME_DEVICE',
  SAME_ADDRESS = 'SAME_ADDRESS',
  REFERRER_UNPROVEN = 'REFERRER_UNPROVEN',
  MONTHLY_LIMIT = 'MONTHLY_LIMIT',
  BELOW_MINIMUM = 'BELOW_MINIMUM',
}

registerEnumType(ReferralRefusal, {
  name: 'ReferralRefusal',
  description: 'Why a referral was not rewarded: the checks against fraud (ADR-807).',
  valuesMap: {
    OWN_CODE: { description: "The order was the referrer's own." },
    NOT_FIRST_ORDER: { description: 'The friend had ordered from the shop before.' },
    SAME_DEVICE: {
      description: "The friend ordered from the referrer's device: the same address and browser.",
    },
    SAME_ADDRESS: { description: "The friend's order went where one of the referrer's went." },
    REFERRER_UNPROVEN: {
      description: 'The referrer has had no order of their own delivered and paid.',
    },
    MONTHLY_LIMIT: { description: 'The referrer was rewarded as often as 30 days allow.' },
    BELOW_MINIMUM: { description: "The friend's goods came to less than the programme asks." },
  },
});

@ObjectType({
  description:
    "The shop's referral programme (MKT-07, ADR-807): once a friend's first order, placed from " +
    "a customer's link, is delivered and paid, both are given store credit, unless the checks " +
    'against fraud refuse it.',
})
export class ReferralProgram {
  @Field({ description: 'Whether it rewards referrals.' })
  enabled!: boolean;

  @Field(() => Money, { description: 'Store credit given to the customer whose link it was.' })
  referrerCredit!: Money;

  @Field(() => Money, { description: 'Store credit given to the friend; zero for none.' })
  friendCredit!: Money;

  @Field(() => Int, { description: 'How many days the credit given lasts.' })
  creditDays!: number;

  @Field(() => Money, {
    description: "What the friend's goods must come to, after their discount; zero for anything.",
  })
  minimumOrder!: Money;

  @Field(() => Int, { description: 'How many referrals a customer is rewarded for in 30 days.' })
  perMonth!: number;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last changed it; null for one never set.',
  })
  updatedAt!: Date | null;
}

@InputType()
export class ReferralProgramInput {
  @Field({ nullable: true, description: 'On only with a plan that includes loyalty.' })
  enabled?: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'Rs 10 to Rs 10,000 of store credit for the referrer, as "200".',
  })
  referrerCredit?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Up to Rs 10,000 of store credit for the friend, as "200"; "0" for none.',
  })
  friendCredit?: string | null;

  @Field(() => Int, { nullable: true, description: 'The credit lasts 7 to 365 days.' })
  creditDays?: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'What the friend\'s goods must come to, up to Rs 1,000,000; "0" for anything.',
  })
  minimumOrder?: string | null;
}

@ObjectType()
export class ReferralProgramUpdatePayload {
  @Field(() => ReferralProgram, { nullable: true })
  referralProgram!: ReferralProgram | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({ description: "A friend's order a customer's code brought (ADR-807)." })
export class Referral {
  @Field(() => ID, { description: "The friend's order." })
  orderId!: string;

  @Field(() => ID, { description: 'The customer whose code it was.' })
  referrerId!: string;

  @Field(() => ID, { description: 'The friend.' })
  friendId!: string;

  @Field(() => ReferralOutcome)
  outcome!: ReferralOutcome;

  @Field(() => ReferralRefusal, { nullable: true, description: 'Why it was refused.' })
  reason!: ReferralRefusal | null;

  @Field(() => Money, { description: 'What the referrer was given.' })
  referrerCredit!: Money;

  @Field(() => Money, { description: 'What the friend was given.' })
  friendCredit!: Money;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}
