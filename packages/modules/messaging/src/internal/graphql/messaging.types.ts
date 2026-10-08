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
  ORDER_OUT_FOR_DELIVERY = 'ORDER_OUT_FOR_DELIVERY',
  ORDER_DELIVERED = 'ORDER_DELIVERED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_PAID = 'ORDER_PAID',
  ORDER_ADVANCE_PAID = 'ORDER_ADVANCE_PAID',
  ORDER_PAYMENT_REMINDER = 'ORDER_PAYMENT_REMINDER',
  ORDER_CONFIRMATION_REMINDER = 'ORDER_CONFIRMATION_REMINDER',
  STORE_CREDIT_GIVEN = 'STORE_CREDIT_GIVEN',
  STORE_CREDIT_EXPIRING = 'STORE_CREDIT_EXPIRING',
  ONE_TIME_CODE = 'ONE_TIME_CODE',
  STOCK_LOW = 'STOCK_LOW',
  STOCK_OUT = 'STOCK_OUT',
  ORDER_ASSIGNED = 'ORDER_ASSIGNED',
  ORDER_MENTIONED = 'ORDER_MENTIONED',
  ORDER_RECEIPT_SENT = 'ORDER_RECEIPT_SENT',
  INVOICE_DUE = 'INVOICE_DUE',
  PLAN_ENDED = 'PLAN_ENDED',
  CREDIT_LOW = 'CREDIT_LOW',
  TRANSFER_CONFIRMED = 'TRANSFER_CONFIRMED',
  TRANSFER_REFUSED = 'TRANSFER_REFUSED',
  DOMAIN_UNPOINTED = 'DOMAIN_UNPOINTED',
  ORDERS_LIMIT_NEAR = 'ORDERS_LIMIT_NEAR',
  ORDERS_LIMIT_REACHED = 'ORDERS_LIMIT_REACHED',
}

registerEnumType(MessageKind, {
  name: 'MessageKind',
  description:
    "A notification the shop's customers get about their orders, an alert the shop gets " +
    'itself, at its alerts number, or one its staff get of their own work, each at their own ' +
    'number (ADR-191).',
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
    ORDER_SHIPPED: {
      description: "A parcel of theirs left with its courier: its tracking, and the order's page.",
    },
    ORDER_OUT_FOR_DELIVERY: {
      description:
        'A parcel of theirs with cash to pay went out for delivery: what to keep ready for the ' +
        "rider, and the order's page (ADR-160).",
    },
    ORDER_DELIVERED: { description: 'A parcel of theirs was delivered.' },
    ORDER_CANCELLED: { description: 'Their order was cancelled.' },
    ORDER_PAID: {
      description:
        'The shop has their payment, the order paid in full before it ships: by transfer, ' +
        'online, or as staff recorded it (ADR-171).',
    },
    ORDER_ADVANCE_PAID: {
      description:
        "The shop has their cash-on-delivery order's advance, before it ships, and what is left " +
        'to pay the rider (ADR-171).',
    },
    ORDER_CONFIRMATION_REMINDER: {
      description:
        'Their cash-on-delivery order asked again to be confirmed, three hours on without an ' +
        "answer, in the shop's calling hours, with the same buttons and link (ADR-175).",
    },
    ORDER_PAYMENT_REMINDER: {
      description:
        'Their order still waits for its payment, a day before the shop cancels it unpaid: what ' +
        'it waits for, by when, and its page (ADR-174).',
    },
    STORE_CREDIT_GIVEN: {
      description:
        'The shop gave them store credit, by hand or as a refund: how much, and what they have in ' +
        'all (ADR-192).',
    },
    STORE_CREDIT_EXPIRING: {
      description:
        'A store credit of theirs with something left expires within the week: how much, and ' +
        'when (ADR-192). Once a credit.',
    },
    ONE_TIME_CODE: {
      description:
        'A code to prove their number at checkout (CHK-09), which the shop cannot turn off; the ' +
        'code is not kept once sent.',
    },
    STOCK_LOW: {
      description:
        'For the shop: a variant fell to its low-stock threshold for sale online (INV-01), once a ' +
        'spell, until it is stocked above it again.',
    },
    STOCK_OUT: { description: 'For the shop: a variant ran out for sale online (INV-01).' },
    ORDER_ASSIGNED: {
      description:
        'For a member of staff, at their own number: an order was given to them to see through ' +
        '(ORD-10, ADR-191), by someone other than themselves.',
    },
    ORDER_MENTIONED: {
      description:
        'For a member of staff, at their own number: a comment on an order names them, as @ and ' +
        'their name (ORD-02, ADR-191).',
    },
    ORDER_RECEIPT_SENT: {
      description:
        'For staff, at their own numbers: a customer sent the receipt of their transfer for an ' +
        'order still waiting for it; told to whom the order is given, else to the owners and ' +
        'managers (PAY-02, ADR-247).',
    },
    INVOICE_DUE: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        "its plan's next period is invoiced and waits for payment (ADR-169, ADR-195).",
    },
    PLAN_ENDED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        'its plan ended, its invoice unpaid, and it is on Free (ADR-169, ADR-195).',
    },
    CREDIT_LOW: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        'its message credit fell below Rs 100 (ADR-169, ADR-195).',
    },
    TRANSFER_CONFIRMED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        "Hatti found the transfer it said it made into Hatti's account, which paid its invoice " +
        '(ADR-254).',
    },
    TRANSFER_REFUSED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        "Hatti did not find the transfer it said it made into Hatti's account, and why (ADR-254).",
    },
    DOMAIN_UNPOINTED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        'DNS points a domain of its own elsewhere, which is disconnected three days on unless it ' +
        'points back (ADR-262).',
    },
    ORDERS_LIMIT_NEAR: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        "it has placed four fifths of the orders its plan allows this month, Free's 40 of 50 " +
        '(ADR-263).',
    },
    ORDERS_LIMIT_REACHED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        'it has placed all the orders its plan allows this month; those past them come in with ' +
        'their customers hidden (ADR-263).',
    },
  },
});

export enum MessageChannel {
  WHATSAPP = 'WHATSAPP',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
}

registerEnumType(MessageChannel, {
  name: 'MessageChannel',
  valuesMap: {
    WHATSAPP: { description: "WhatsApp, from Hatti's shared notifications number." },
    SMS: { description: "SMS, from Hatti's shared sender." },
    EMAIL: {
      description:
        "Email, from Hatti's address under the shop's name, to the address the customer gave " +
        "with their order: the order's news, beside its WhatsApp message or SMS, at no cost to " +
        'the shop (ADR-181).',
    },
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

  @Field({
    description:
      "The customer's number, masked for staff who see numbers masked; an email's, their address.",
  })
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

  @Field(() => String, {
    nullable: true,
    description:
      "Where Hatti's alerts to the shop go on WhatsApp, such as low stock and its bills with " +
      'Hatti: a mobile number, in E.164. None sends none.',
  })
  alertsPhone!: string | null;

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

  @Field(() => String, {
    nullable: true,
    description:
      'Where Hatti\'s alerts to the shop go: a Pakistani mobile, as "0300 1234567" or ' +
      '"+923001234567". Null or blank stops them.',
  })
  alertsPhone?: string | null;
}

@ObjectType()
export class MessagingSettingsUpdatePayload {
  @Field(() => MessagingSettings, { nullable: true })
  messagingSettings!: MessagingSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
