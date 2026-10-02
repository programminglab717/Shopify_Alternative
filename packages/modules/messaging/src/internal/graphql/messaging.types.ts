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

export enum MessageKind {
  ORDER_PLACED = 'ORDER_PLACED',
  ORDER_CONFIRMATION = 'ORDER_CONFIRMATION',
  ORDER_CONFIRMED = 'ORDER_CONFIRMED',
  ORDER_ADDRESS = 'ORDER_ADDRESS',
  ORDER_SHIPPED = 'ORDER_SHIPPED',
  ORDER_DELIVERED = 'ORDER_DELIVERED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
}

registerEnumType(MessageKind, {
  name: 'MessageKind',
  description: "A notification the shop's customers get about their orders.",
  valuesMap: {
    ORDER_PLACED: { description: 'Their order was placed: its total.' },
    ORDER_CONFIRMATION: {
      description:
        'Their cash-on-delivery order waits for them: Confirm, Cancel and Change address ' +
        'buttons on WhatsApp, its link by SMS (COD-01). In place of ORDER_PLACED.',
    },
    ORDER_CONFIRMED: { description: 'Their order was confirmed, by them or by the shop.' },
    ORDER_ADDRESS: {
      description: "They asked to change their order's address: its page, where they can.",
    },
    ORDER_SHIPPED: { description: 'A parcel of theirs left with its courier: its tracking.' },
    ORDER_DELIVERED: { description: 'A parcel of theirs was delivered.' },
    ORDER_CANCELLED: { description: 'Their order was cancelled.' },
  },
});

export enum MessageChannel {
  WHATSAPP = 'WHATSAPP',
  SMS = 'SMS',
}

registerEnumType(MessageChannel, {
  name: 'MessageChannel',
  valuesMap: {
    WHATSAPP: { description: "WhatsApp, from Hatti's shared notifications number." },
    SMS: { description: "SMS, from Hatti's shared sender." },
  },
});

export enum MessageStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

registerEnumType(MessageStatus, {
  name: 'MessageStatus',
  valuesMap: {
    PENDING: { description: 'Waiting to go, or to be tried again.' },
    SENT: { description: 'Its channel took it.' },
    DELIVERED: { description: "It reached the customer's phone." },
    READ: { description: 'The customer read it: WhatsApp alone says.' },
    FAILED: {
      description:
        'Its channel could not deliver it: `error` says why. A WhatsApp one went by SMS.',
    },
    SKIPPED: { description: 'Not sent: the customer asked the shop to stop.' },
  },
});

export enum MessageRouting {
  RICH = 'RICH',
  ECONOMY = 'ECONOMY',
}

registerEnumType(MessageRouting, {
  name: 'MessageRouting',
  valuesMap: {
    RICH: { description: 'Every update on WhatsApp, by SMS when WhatsApp cannot deliver it.' },
    ECONOMY: {
      description: 'Updates by SMS, which costs less for a message that needs no answer.',
    },
  },
});

export enum MessageLanguage {
  EN = 'EN',
  UR = 'UR',
}

registerEnumType(MessageLanguage, { name: 'MessageLanguage' });

@ObjectType({
  description:
    "A message to one of the shop's customers about their order (MSG-01, ADR-146), and how " +
    'sending it went.',
})
export class Message {
  @Field(() => ID)
  id!: string;

  @Field(() => MessageKind)
  kind!: MessageKind;

  @Field(() => MessageChannel)
  channel!: MessageChannel;

  @Field({ description: "The customer's number, masked for staff who see numbers masked." })
  recipient!: string;

  @Field(() => MessageLanguage)
  language!: MessageLanguage;

  @Field(() => MessageStatus)
  status!: MessageStatus;

  @Field(() => Int, { description: 'Tries to send it so far.' })
  attempts!: number;

  @Field(() => ID, { nullable: true })
  orderId!: string | null;

  @Field(() => String, { nullable: true, description: 'Why it failed or was skipped.' })
  error!: string | null;

  @Field(() => ID, {
    nullable: true,
    description: 'The WhatsApp message an SMS went in place of.',
  })
  replacesId!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  sentAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  deliveredAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  readAt!: Date | null;

  @Field(() => GraphQLISODateTime, { description: 'When it was queued.' })
  createdAt!: Date;
}

@ObjectType()
export class MessageEdge {
  @Field()
  cursor!: string;

  @Field(() => Message)
  node!: Message;
}

@ObjectType()
export class MessageConnection {
  @Field(() => [MessageEdge])
  edges!: MessageEdge[];

  @Field(() => [Message])
  nodes!: Message[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class MessagesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => MessageStatus, { nullable: true, description: 'Those of this status alone.' })
  status?: MessageStatus | null;

  @Field(() => ID, { nullable: true, description: "This order's alone." })
  orderId?: string | null;
}

@ObjectType({ description: "How the shop's customers are told about their orders." })
export class MessagingSettings {
  @Field(() => MessageRouting)
  routing!: MessageRouting;

  @Field(() => MessageLanguage, { description: "The messages' language." })
  language!: MessageLanguage;

  @Field(() => [MessageKind], { description: 'The notifications the shop turned off.' })
  disabledNotifications!: MessageKind[];

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null while never changed.' })
  updatedAt!: Date | null;
}

@InputType()
export class MessagingSettingsInput {
  @Field(() => MessageRouting, { nullable: true })
  routing?: MessageRouting | null;

  @Field(() => MessageLanguage, { nullable: true })
  language?: MessageLanguage | null;

  @Field(() => [MessageKind], {
    nullable: true,
    description: 'The notifications to turn off, all of them; the others are on.',
  })
  disabledNotifications?: MessageKind[] | null;
}

@ObjectType()
export class MessagingSettingsUpdatePayload {
  @Field(() => MessagingSettings, { nullable: true })
  messagingSettings!: MessagingSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
