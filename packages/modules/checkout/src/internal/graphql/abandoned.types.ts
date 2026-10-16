import { Money, UserError } from '@hatti/api';
import { DiscountCode } from '@hatti/pricing/public';
import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'An item as the cart held it when the shopper typed their number.' })
export class AbandonedCheckoutLineItem {
  @Field(() => ID, { description: 'The variant. It may have been deleted since.' })
  variantId!: string;

  @Field({ description: "The product's title then." })
  title!: string;

  @Field({ description: 'The variant\'s title then, such as "Red / M" or "Default Title".' })
  variantTitle!: string;

  @Field(() => Int)
  quantity!: number;
}

@ObjectType({ description: 'The order that recovered an abandoned checkout.' })
export class AbandonedCheckoutOrder {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Its number as staff say it, such as #1001.' })
  name!: string;
}

@ObjectType({
  description:
    'A checkout its shopper left after typing their number, kept 30 days (CHK-12, ADR-393): ' +
    "as Shopify's abandoned checkouts, with the number in place of an email.",
})
export class AbandonedCheckout {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime, { description: 'When the shopper started it.' })
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When they last typed their number.' })
  abandonedAt!: Date;

  @Field(() => String, { nullable: true, description: 'The name they typed, if any.' })
  name!: string | null;

  @Field({
    description:
      'The number they typed, in E.164; masked like "0300 ••••567" for roles that see ' +
      "customers' numbers masked.",
  })
  phone!: string;

  @Field(() => [AbandonedCheckoutLineItem])
  lineItems!: AbandonedCheckoutLineItem[];

  @Field(() => Money, { description: 'What the items came to then.' })
  subtotalPrice!: Money;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When they were reminded on WhatsApp; null while they were not.',
  })
  remindedAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When they were offered a discount code after the reminder (ADR-426).',
  })
  offeredAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'The code they were offered, as it was named then.',
  })
  offerCode!: string | null;

  @Field(() => AbandonedCheckoutOrder, {
    nullable: true,
    description: 'The order the same number placed since, after the reminder or not.',
  })
  recoveredOrder!: AbandonedCheckoutOrder | null;
}

@ObjectType({
  description:
    'Whether, and how long after they leave, the shop reminds shoppers who typed their number ' +
    'at checkout, once, on WhatsApp, with a link back to their items (ADR-393); and the ' +
    'discount code it offers those who still have not ordered, some hours after (ADR-426).',
})
export class CheckoutRecoverySettings {
  @Field(() => Int, {
    nullable: true,
    description: '30, 60, 180 or 600 minutes; null for never, as until the shop chooses.',
  })
  reminderAfterMinutes!: number | null;

  @Field(() => DiscountCode, {
    nullable: true,
    description:
      "The shop's code offered after the reminder, a percentage or an amount off, applied to " +
      'the cart its link opens; null for none, as when the code chosen was deleted.',
  })
  offerDiscountCode!: DiscountCode | null;

  @Field(() => Int, {
    nullable: true,
    description: 'How many hours after the reminder: 12, 24 or 48; null with no offer.',
  })
  offerAfterHours!: number | null;
}

@ObjectType()
export class CheckoutRecoverySettingsUpdatePayload {
  @Field(() => CheckoutRecoverySettings, { nullable: true })
  checkoutRecoverySettings!: CheckoutRecoverySettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
