import { UserError } from '@hatti/api';
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
  },
});

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
}

@ObjectType()
export class MarketingAutomationUpdatePayload {
  @Field(() => MarketingAutomation, { nullable: true })
  marketingAutomation!: MarketingAutomation | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
