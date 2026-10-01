import { UserError } from '@hatti/api';
import { Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum CheckoutTrustBadgeKind {
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
  OPEN_PARCEL = 'OPEN_PARCEL',
  EXCHANGE = 'EXCHANGE',
  RETURNS = 'RETURNS',
  ORIGINAL = 'ORIGINAL',
  WHATSAPP = 'WHATSAPP',
}

registerEnumType(CheckoutTrustBadgeKind, {
  name: 'CheckoutTrustBadgeKind',
  description:
    "A badge from the platform's set, which the checkout's page words in English and Urdu.",
  valuesMap: {
    CASH_ON_DELIVERY: {
      description: '"Cash on delivery": shown where the page offers it for the cart.',
    },
    OPEN_PARCEL: {
      description:
        '"Open your parcel before you pay": shown where the page offers cash on delivery for ' +
        'the cart.',
    },
    EXCHANGE: {
      description: '"7-day exchange", with its days: linked to the refund policy, if any.',
    },
    RETURNS: {
      description: '"7-day returns", with its days: linked to the refund policy, if any.',
    },
    ORIGINAL: { description: '"100% original products".' },
    WHATSAPP: {
      description: '"Help on WhatsApp": a link to a chat with the shop\'s WhatsApp number.',
    },
  },
});

@ObjectType({
  description:
    "A badge the shop chose for its checkout's page, under the button that places the order " +
    '(CHK-14).',
})
export class CheckoutTrustBadge {
  @Field(() => CheckoutTrustBadgeKind)
  kind!: CheckoutTrustBadgeKind;

  @Field(() => Int, {
    nullable: true,
    description: 'For EXCHANGE and RETURNS: within how many days; null for the rest.',
  })
  days!: number | null;
}

@InputType()
export class CheckoutTrustBadgeInput {
  @Field(() => CheckoutTrustBadgeKind)
  kind!: CheckoutTrustBadgeKind;

  @Field(() => Int, {
    nullable: true,
    description: 'For EXCHANGE and RETURNS, which need it: 1 to 90. None for the rest.',
  })
  days?: number | null;
}

@ObjectType()
export class CheckoutTrustBadgesUpdatePayload {
  @Field(() => [CheckoutTrustBadge], { nullable: true })
  checkoutTrustBadges!: CheckoutTrustBadge[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
