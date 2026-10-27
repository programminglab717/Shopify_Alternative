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
import { WhatsAppTemplate } from './whatsapp-template.types.js';

export enum MarketingAutomationKind {
  WELCOME = 'WELCOME',
  WIN_BACK = 'WIN_BACK',
  BACK_IN_STOCK = 'BACK_IN_STOCK',
  COD_PREPAID = 'COD_PREPAID',
  CASHBACK = 'CASHBACK',
}

registerEnumType(MarketingAutomationKind, {
  name: 'MarketingAutomationKind',
  description: "One of the shop's automations' recipes (MKT-04, ADR-425).",
  valuesMap: {
    WELCOME: {
      description:
        'Once, to a customer who agrees to hear from the shop on WhatsApp at checkout or on its ' +
        'storefront.',
    },
    WIN_BACK: {
      description:
        'To a customer who agreed to hear on WhatsApp, some days after their last order: once ' +
        'each time they lapse.',
    },
    BACK_IN_STOCK: {
      description:
        'Once, to a shopper who asked on the storefront to hear when a sold-out variant is for ' +
        "sale again: from Hatti's number, with the product's link, needing no template of the " +
        "shop's (ADR-429).",
    },
    COD_PREPAID: {
      description:
        'Once, when a cash-on-delivery order is confirmed: store credit offered for paying the ' +
        "rest online before it is packed, from Hatti's number with the order's link, needing no " +
        "template of the shop's (ADR-432).",
    },
    CASHBACK: {
      description:
        'Once an order is delivered and paid in full: a share of its goods given back in store ' +
        "credit, which its customer spends at checkout and hears of on WhatsApp from Hatti's " +
        "number, needing no template of the shop's (PAY-13, ADR-453).",
    },
  },
});

@ObjectType({
  description:
    'A tier of cashback (MKT-06, ADR-806): a larger share for customers who have spent at least ' +
    'so much on their other orders.',
})
export class CashbackTier {
  @Field({ description: 'Its name, as Gold.' })
  name!: string;

  @Field(() => Money, { description: 'What a customer has spent on their other orders from.' })
  spent!: Money;

  @Field(() => Int, { description: "The share of an order's goods it gives back, in percent." })
  percent!: number;
}

@InputType()
export class CashbackTierInput {
  @Field({ description: 'Its name, in 40 characters at most.' })
  name!: string;

  @Field({ description: 'What a customer has spent on their other orders from, as "20000".' })
  spent!: string;

  @Field(() => Int, {
    description: "1 to 20 percent of an order's goods, more than those who spent less get.",
  })
  percent!: number;
}

@ObjectType({
  description:
    "One of the shop's automations (ADR-425): one of its approved WhatsApp templates, sent from " +
    'its own number when something happens to a customer who agreed to hear from it there.',
})
export class MarketingAutomation {
  @Field(() => MarketingAutomationKind)
  kind!: MarketingAutomationKind;

  @Field({ description: 'Whether it sends.' })
  enabled!: boolean;

  @Field(() => WhatsAppTemplate, {
    nullable: true,
    description: 'The template it sends; null when none was chosen, or the one chosen is gone.',
  })
  template!: WhatsAppTemplate | null;

  @Field(() => Int, {
    nullable: true,
    description: "For a win-back: how many days after the customer's last order it goes.",
  })
  afterDays!: number | null;

  @Field(() => Money, {
    nullable: true,
    description: 'For COD to prepaid: the store credit offered for paying online.',
  })
  creditAmount!: Money | null;

  @Field(() => Int, {
    nullable: true,
    description: "For cashback: the share of an order's goods given back, in whole percent.",
  })
  cashbackPercent!: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'For cashback: how many days the store credit given lasts.',
  })
  creditDays!: number | null;

  @Field(() => [CashbackTier], {
    nullable: true,
    description:
      'For cashback: its tiers, by what they start from, each giving back more; the share above ' +
      'for those who spent less than any (ADR-806).',
  })
  cashbackTiers!: CashbackTier[] | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last changed it; null for one never set.',
  })
  updatedAt!: Date | null;
}

@InputType()
export class MarketingAutomationInput {
  @Field({ nullable: true, description: 'On only with a template Meta approved.' })
  enabled?: boolean;

  @Field(() => ID, { nullable: true, description: "One of the shop's templates." })
  templateId?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: "For a win-back: 14 to 365 days after the customer's last order.",
  })
  afterDays?: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'For COD to prepaid: Rs 10 to Rs 10,000 of store credit, as "100".',
  })
  creditAmount?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: "For cashback: 1 to 20 percent of an order's goods given back.",
  })
  cashbackPercent?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'For cashback: the store credit given lasts 7 to 365 days.',
  })
  creditDays?: number | null;

  @Field(() => [CashbackTierInput], {
    nullable: true,
    description: 'For cashback: all its tiers, at most three; [] for none.',
  })
  cashbackTiers?: CashbackTierInput[] | null;
}

@ObjectType()
export class MarketingAutomationUpdatePayload {
  @Field(() => MarketingAutomation, { nullable: true })
  marketingAutomation!: MarketingAutomation | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
