import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum MarketingChannel {
  WHATSAPP = 'WHATSAPP',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
}

registerEnumType(MarketingChannel, {
  name: 'MarketingChannel',
  description: 'A channel marketing goes out on. Each has its own consent.',
});

export enum MarketingState {
  NOT_SUBSCRIBED = 'NOT_SUBSCRIBED',
  SUBSCRIBED = 'SUBSCRIBED',
  UNSUBSCRIBED = 'UNSUBSCRIBED',
}

registerEnumType(MarketingState, {
  name: 'MarketingState',
  valuesMap: {
    NOT_SUBSCRIBED: { description: 'Never asked, or the number or address has changed since.' },
    SUBSCRIBED: { description: 'Agreed to marketing on this channel.' },
    UNSUBSCRIBED: { description: 'Said no, or asked to stop.' },
  },
});

export enum ConsentSource {
  MANUAL = 'MANUAL',
  API = 'API',
  IMPORT = 'IMPORT',
  CHECKOUT = 'CHECKOUT',
  REPLY = 'REPLY',
  CONTACT_CHANGED = 'CONTACT_CHANGED',
}

registerEnumType(ConsentSource, {
  name: 'ConsentSource',
  description: 'Where a customer gave or withdrew consent.',
  valuesMap: {
    MANUAL: { description: 'Recorded by staff, e.g. from a chat or a call.' },
    API: { description: 'Recorded by an app.' },
    IMPORT: { description: 'Imported from another platform.' },
    CHECKOUT: { description: 'Ticked at checkout.' },
    REPLY: { description: 'Replied to a message, e.g. with STOP.' },
    CONTACT_CHANGED: { description: 'Their number or email changed, so consent started again.' },
  },
});

@ObjectType({ description: 'Whether a customer agreed to marketing on a channel.' })
export class CustomerMarketingConsent {
  @Field(() => MarketingState)
  marketingState!: MarketingState;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When they gave or withdrew it; null if they never have.',
  })
  consentUpdatedAt!: Date | null;
}

@ObjectType({
  description:
    'A customer: whoever a mobile number belongs to. Orders find or create their customer by ' +
    'number.',
})
export class Customer {
  @Field(() => ID)
  id!: string;

  @Field({
    description:
      'Their main mobile number in E.164 form, e.g. "+923001234567": who they are, and where ' +
      'marketing goes. Staff other than owners and managers see it masked, "0300 ••••567"; ' +
      'confirmation agents reveal it with customerPhoneReveal, which is logged.',
  })
  phone!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field({ description: 'The name, or the number when there is none: "0300 1234567".' })
  displayName!: string;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field({ description: 'For staff.' })
  note!: string;

  @Field(() => [String])
  tags!: string[];

  @Field(() => CustomerMarketingConsent)
  whatsappMarketingConsent!: CustomerMarketingConsent;

  @Field(() => CustomerMarketingConsent)
  smsMarketingConsent!: CustomerMarketingConsent;

  @Field(() => CustomerMarketingConsent)
  emailMarketingConsent!: CustomerMarketingConsent;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  /** For field resolvers. */
  uuid!: string;
}

@ObjectType({
  description:
    'A change of marketing consent, as the consent ledger keeps it: what the customer agreed ' +
    'to, where, when, and for which number or address.',
})
export class ConsentEvent {
  @Field(() => ID)
  id!: string;

  @Field(() => MarketingChannel)
  channel!: MarketingChannel;

  @Field(() => MarketingState)
  marketingState!: MarketingState;

  @Field(() => ConsentSource)
  source!: ConsentSource;

  @Field(() => String, { nullable: true, description: 'What the customer agreed to.' })
  wording!: string | null;

  @Field({
    description:
      'The mobile number (E.164) or email address it was for. Numbers are masked for staff who ' +
      'see them masked.',
  })
  contact!: string;

  @Field(() => GraphQLISODateTime, { description: 'When the customer said so.' })
  collectedAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When it was recorded.' })
  recordedAt!: Date;
}

@ObjectType()
export class ConsentEventEdge {
  @Field()
  cursor!: string;

  @Field(() => ConsentEvent)
  node!: ConsentEvent;
}

@ObjectType()
export class ConsentEventConnection {
  @Field(() => [ConsentEventEdge])
  edges!: ConsentEventEdge[];

  @Field(() => [ConsentEvent])
  nodes!: ConsentEvent[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ConsentHistoryArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType()
export class MarketingConsentInput {
  @Field(() => MarketingChannel)
  channel!: MarketingChannel;

  @Field(() => MarketingState, { description: 'SUBSCRIBED or UNSUBSCRIBED.' })
  marketingState!: MarketingState;

  @Field(() => String, {
    nullable: true,
    description:
      'What the customer agreed to, e.g. the text beside a checkbox. Needed to subscribe.',
  })
  wording?: string | null;

  @Field(() => ConsentSource, {
    nullable: true,
    description: 'Where they said so: MANUAL for staff and API for apps when left out.',
  })
  source?: ConsentSource | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When they said so, if before now.',
  })
  collectedAt?: Date | null;
}

@ObjectType()
export class CustomerEdge {
  @Field()
  cursor!: string;

  @Field(() => Customer)
  node!: Customer;
}

@ObjectType()
export class CustomerConnection {
  @Field(() => [CustomerEdge])
  edges!: CustomerEdge[];

  @Field(() => [Customer])
  nodes!: Customer[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class CustomersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'A mobile number in any format, four or more of its digits, or words of the name or email.',
  })
  query?: string | null;
}

@InputType()
export class CustomerCreateInput {
  @Field({ description: 'A Pakistani mobile number, in any common format: their main one.' })
  phone!: string;

  @Field(() => [String], {
    nullable: true,
    description: 'Up to 10 more numbers of theirs, such as a second SIM.',
  })
  otherPhones?: string[] | null;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => String, { nullable: true })
  email?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;

  @Field(() => [MarketingConsentInput], {
    nullable: true,
    description: 'Consent they gave, or withdrew, when added.',
  })
  marketingConsent?: MarketingConsentInput[] | null;
}

@InputType({
  description:
    'Fields left out stay as they are. A new main number resets WhatsApp and SMS consent; a new ' +
    'or removed email resets email consent.',
})
export class CustomerUpdateInput {
  @Field(() => String, {
    nullable: true,
    description:
      "Their main number; must not be another customer's. The old one goes unless listed in " +
      'otherPhones. Their orders keep the numbers they were placed with.',
  })
  phone?: string | null;

  @Field(() => [String], {
    nullable: true,
    description: "Replaces their other numbers; none may be another customer's. null clears them.",
  })
  otherPhones?: string[] | null;

  @Field(() => String, { nullable: true, description: 'null clears it.' })
  name?: string | null;

  @Field(() => String, { nullable: true, description: 'null clears it.' })
  email?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;
}

@ObjectType()
export class CustomerCreatePayload {
  @Field(() => Customer, { nullable: true })
  customer!: Customer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomerUpdatePayload {
  @Field(() => Customer, { nullable: true })
  customer!: Customer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomerMarketingConsentUpdatePayload {
  @Field(() => Customer, { nullable: true })
  customer!: Customer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomerMergePayload {
  @Field(() => Customer, { nullable: true, description: 'The customer, with the duplicate in.' })
  customer!: Customer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomerPhoneRevealPayload {
  @Field(() => String, { nullable: true, description: 'Their main number, E.164.' })
  phone!: string | null;

  @Field(() => [String])
  otherPhones!: string[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomerErasePayload {
  @Field(() => ID, { nullable: true })
  erasedCustomerId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

export enum BlocklistReason {
  FAKE_ORDERS = 'FAKE_ORDERS',
  REFUSED_DELIVERIES = 'REFUSED_DELIVERIES',
  ABUSE = 'ABUSE',
  FRAUD = 'FRAUD',
  OTHER = 'OTHER',
}

registerEnumType(BlocklistReason, {
  name: 'BlocklistReason',
  description: 'Why a number is on the blocklist.',
  valuesMap: {
    FAKE_ORDERS: { description: 'Placed fake or prank orders.' },
    REFUSED_DELIVERIES: { description: 'Refused parcels at the door.' },
    ABUSE: { description: 'Abusive to staff or couriers.' },
    FRAUD: { description: 'Fraud, such as a fake payment receipt.' },
    OTHER: {},
  },
});

@ObjectType({
  description: 'A number on the blocklist. Orders from it are held for staff to review.',
})
export class BlocklistEntry {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Mobile number in E.164 form; masked for staff who see numbers masked.' })
  phone!: string;

  @Field(() => BlocklistReason)
  reason!: BlocklistReason;

  @Field({ description: 'What happened, for staff.' })
  note!: string;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime, { description: 'When the number was blocked.' })
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class BlocklistEntryEdge {
  @Field()
  cursor!: string;

  @Field(() => BlocklistEntry)
  node!: BlocklistEntry;
}

@ObjectType()
export class BlocklistEntryConnection {
  @Field(() => [BlocklistEntryEdge])
  edges!: BlocklistEntryEdge[];

  @Field(() => [BlocklistEntry])
  nodes!: BlocklistEntry[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class BlocklistArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A mobile number in any format, or four or more of its digits.',
  })
  query?: string | null;
}

@InputType()
export class BlocklistAddInput {
  @Field({ description: 'A Pakistani mobile number, in any common format.' })
  phone!: string;

  @Field(() => BlocklistReason)
  reason!: BlocklistReason;

  @Field(() => String, { nullable: true, description: 'What happened, for staff.' })
  note?: string | null;
}

@ObjectType()
export class BlocklistAddPayload {
  @Field(() => BlocklistEntry, { nullable: true })
  blocklistEntry!: BlocklistEntry | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class BlocklistRemovePayload {
  @Field(() => ID, { nullable: true })
  deletedBlocklistEntryId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
