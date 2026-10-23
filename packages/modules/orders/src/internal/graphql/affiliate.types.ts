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

/** How an order came to an affiliate (ADR-776). */
export enum AffiliateOrderSource {
  CODE = 'CODE',
  LINK = 'LINK',
}
registerEnumType(AffiliateOrderSource, {
  name: 'AffiliateOrderSource',
  description: "By the affiliate's discount code, or by their link.",
});

@ObjectType({
  description:
    "What an affiliate's orders came to (ADR-776), worked out from the orders when asked: they " +
    'earn their share of an order once it is delivered, and nothing if it comes back.',
})
export class AffiliateStats {
  @Field(() => Int, { description: 'Orders they brought, cancelled ones aside.' })
  orders!: number;

  @Field(() => Int, { description: 'Of those, the ones delivered.' })
  delivered!: number;

  @Field(() => Money, {
    description: "What the delivered orders' items came to, after discounts and refunds.",
  })
  sales!: Money;

  @Field(() => Money, { description: 'Their share of `sales`.' })
  earned!: Money;

  @Field(() => Money, {
    description: 'Their share of the orders still on their way, earned once delivered.',
  })
  pending!: Money;

  @Field(() => Money, { description: 'What the shop recorded paying them.' })
  paid!: Money;

  @Field(() => Money, {
    description: 'What is earned and not paid; below zero where the shop paid ahead.',
  })
  owed!: Money;
}

@ObjectType({
  description:
    'Someone who sends the shop customers by a link of their own, the storefront with ?ref=, or ' +
    'one of its discount codes, and earns a share of the orders they bring (MKT-08, ADR-776).',
})
export class Affiliate {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true, description: 'Their mobile number, in E.164.' })
  phone!: string | null;

  @Field({ description: 'What their link carries after ?ref=.' })
  ref!: string;

  @Field(() => String, {
    nullable: true,
    description: "One of the shop's discount codes, upper case; null for a link alone.",
  })
  discountCode!: string | null;

  @Field({ description: 'Their share of what an order\'s items came to, in percent: "7.5".' })
  commission!: string;

  @Field({ description: 'False once the shop ended their part.' })
  active!: boolean;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop ended their part: orders placed after it earn them nothing.',
  })
  endedAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    description: 'Orders placed before it are not theirs.',
  })
  createdAt!: Date;

  @Field(() => AffiliateStats)
  stats!: AffiliateStats;
}

@ObjectType({ description: "One of an affiliate's orders, with what it earns them." })
export class AffiliateOrder {
  @Field(() => ID)
  orderId!: string;

  @Field({ description: 'As the shop names its orders: "#1001".' })
  name!: string;

  @Field(() => GraphQLISODateTime)
  placedAt!: Date;

  @Field({ description: "The order's stage, as `Order.stage` gives it, in lower case." })
  stage!: string;

  @Field(() => AffiliateOrderSource)
  source!: AffiliateOrderSource;

  @Field(() => Money, { description: 'What its items came to, after discounts and refunds.' })
  base!: Money;

  @Field(() => Money, {
    description: 'Their share of it: earned once delivered, nothing if it comes back.',
  })
  commission!: Money;
}

@ObjectType({ description: 'What the shop recorded paying an affiliate.' })
export class AffiliatePayout {
  @Field(() => ID)
  id!: string;

  @Field(() => Money)
  amount!: Money;

  @Field()
  note!: string;

  @Field(() => GraphQLISODateTime)
  paidAt!: Date;
}

@InputType()
export class AffiliateCreateInput {
  @Field({ description: 'Up to 100 characters.' })
  name!: string;

  @Field(() => String, { nullable: true, description: 'A Pakistani mobile number.' })
  phone?: string | null;

  @Field({
    description:
      'What their link carries after ?ref=: 2 to 40 letters, digits and hyphens, kept in lower ' +
      "case, unique among the shop's affiliates.",
  })
  ref!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "One of the shop's discount codes: orders placed with it are theirs, whatever brought " +
      "the customer. Unique among the shop's affiliates.",
  })
  discountCode?: string | null;

  @Field({
    description: 'Their share of what an order\'s items came to, in percent, to two places: "10".',
  })
  commission!: string;
}

@InputType()
export class AffiliateUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => String, { nullable: true, description: 'Blank takes it off.' })
  phone?: string | null;

  @Field(() => String, { nullable: true })
  ref?: string | null;

  @Field(() => String, { nullable: true, description: 'Blank takes it off.' })
  discountCode?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A new share counts for all their orders, those before it too.',
  })
  commission?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'False ends their part from now: orders placed after it earn them nothing. True takes ' +
      'them back.',
  })
  active?: boolean | null;
}

@InputType()
export class AffiliatePayoutRecordInput {
  @Field(() => ID)
  affiliateId!: string;

  @Field({ description: 'What was paid, as the shop writes it: "2500".' })
  amount!: string;

  @Field(() => String, { nullable: true, description: 'Up to 200 characters: how it was paid.' })
  note?: string | null;
}

@ObjectType()
export class AffiliateCreatePayload {
  @Field(() => Affiliate, { nullable: true })
  affiliate!: Affiliate | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class AffiliateUpdatePayload {
  @Field(() => Affiliate, { nullable: true })
  affiliate!: Affiliate | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class AffiliatePayoutRecordPayload {
  @Field(() => AffiliatePayout, { nullable: true })
  payout!: AffiliatePayout | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
