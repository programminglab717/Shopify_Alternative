import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum WhatsAppQualityRating {
  GREEN = 'GREEN',
  YELLOW = 'YELLOW',
  RED = 'RED',
  UNKNOWN = 'UNKNOWN',
}

registerEnumType(WhatsAppQualityRating, {
  name: 'WhatsAppQualityRating',
  description:
    "How Meta rates the messages a number sends, from its customers' blocks and reports: RED " +
    'ones lower what it may send in a day.',
  valuesMap: {
    UNKNOWN: { description: 'Meta has not rated it yet, as for a number new to sending.' },
  },
});

@ObjectType({
  description:
    "The shop's own WhatsApp number (MKT-01, ADR-419), connected through Meta's Embedded " +
    "Signup: broadcasts and the shop's own templates go from it.",
})
export class WhatsAppAccount {
  @Field({ description: 'The ID of the WhatsApp Business Account the number is in.' })
  businessAccountId!: string;

  @Field({ description: "The number's ID in WhatsApp's Cloud API." })
  phoneNumberId!: string;

  @Field({ description: 'The number as Meta shows it: "+92 300 1234567".' })
  displayPhoneNumber!: string;

  @Field({ description: 'The business name Meta approved for the number, which customers see.' })
  verifiedName!: string;

  @Field(() => WhatsAppQualityRating)
  qualityRating!: WhatsAppQualityRating;

  @Field(() => GraphQLISODateTime)
  connectedAt!: Date;
}

@ObjectType({
  description:
    "What the admin starts Meta's Embedded Signup with, through Facebook's JavaScript SDK.",
})
export class WhatsAppSignup {
  @Field({ description: "Hatti's Meta app." })
  appId!: string;

  @Field({ description: 'The Facebook Login for Business configuration of Embedded Signup.' })
  configurationId!: string;

  @Field({ description: 'The Graph API version the SDK is started with: "v26.0".' })
  graphVersion!: string;
}

@InputType()
export class WhatsAppAccountConnectInput {
  @Field({ description: 'The code Embedded Signup gave, which the core exchanges with Meta.' })
  code!: string;

  @Field({ description: 'The WhatsApp Business Account Embedded Signup shared.' })
  businessAccountId!: string;

  @Field({ description: 'The number Embedded Signup shared, in that account.' })
  phoneNumberId!: string;
}

@ObjectType()
export class WhatsAppAccountConnectPayload {
  @Field(() => WhatsAppAccount, { nullable: true })
  whatsAppAccount!: WhatsAppAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class WhatsAppAccountDisconnectPayload {
  @Field(() => String, {
    nullable: true,
    description: 'The number disconnected, as Meta showed it; null if none was connected.',
  })
  disconnectedPhoneNumber!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
