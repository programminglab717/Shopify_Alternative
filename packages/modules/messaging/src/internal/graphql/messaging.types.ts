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
  ORDER_DELIVERY_FAILED = 'ORDER_DELIVERY_FAILED',
  ORDER_READY_FOR_PICKUP = 'ORDER_READY_FOR_PICKUP',
  ORDER_DELIVERED = 'ORDER_DELIVERED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_PAID = 'ORDER_PAID',
  ORDER_ADVANCE_PAID = 'ORDER_ADVANCE_PAID',
  ORDER_PART_PAID = 'ORDER_PART_PAID',
  ORDER_PAYMENT_REMINDER = 'ORDER_PAYMENT_REMINDER',
  ORDER_CONFIRMATION_REMINDER = 'ORDER_CONFIRMATION_REMINDER',
  ORDER_CONFIRMATION_CALL = 'ORDER_CONFIRMATION_CALL',
  RETURN_APPROVED = 'RETURN_APPROVED',
  RETURN_DECLINED = 'RETURN_DECLINED',
  STORE_CREDIT_GIVEN = 'STORE_CREDIT_GIVEN',
  STORE_CREDIT_EXPIRING = 'STORE_CREDIT_EXPIRING',
  GIFT_CARD = 'GIFT_CARD',
  CHECKOUT_REMINDER = 'CHECKOUT_REMINDER',
  CHECKOUT_OFFER = 'CHECKOUT_OFFER',
  REVIEW_REQUEST = 'REVIEW_REQUEST',
  BACK_IN_STOCK = 'BACK_IN_STOCK',
  COD_PREPAID = 'COD_PREPAID',
  STORE_OPEN = 'STORE_OPEN',
  ONE_TIME_CODE = 'ONE_TIME_CODE',
  ACCOUNT_CODE = 'ACCOUNT_CODE',
  ERASURE_DONE = 'ERASURE_DONE',
  STOCK_LOW = 'STOCK_LOW',
  STOCK_OUT = 'STOCK_OUT',
  DAILY_SUMMARY = 'DAILY_SUMMARY',
  ORDERS_OVERDUE = 'ORDERS_OVERDUE',
  ORDER_ASSIGNED = 'ORDER_ASSIGNED',
  ORDER_MENTIONED = 'ORDER_MENTIONED',
  ORDER_RECEIPT_SENT = 'ORDER_RECEIPT_SENT',
  CUSTOMER_REFUSED = 'CUSTOMER_REFUSED',
  INVOICE_DUE = 'INVOICE_DUE',
  PAYMENT_OVERDUE = 'PAYMENT_OVERDUE',
  PLAN_ENDED = 'PLAN_ENDED',
  CREDIT_LOW = 'CREDIT_LOW',
  TRANSFER_CONFIRMED = 'TRANSFER_CONFIRMED',
  TRANSFER_REFUSED = 'TRANSFER_REFUSED',
  DOMAIN_UNPOINTED = 'DOMAIN_UNPOINTED',
  ORDERS_LIMIT_NEAR = 'ORDERS_LIMIT_NEAR',
  ORDERS_LIMIT_REACHED = 'ORDERS_LIMIT_REACHED',
  STORE_EXPORT_READY = 'STORE_EXPORT_READY',
  STORE_SUSPENDED = 'STORE_SUSPENDED',
  STORE_APPEAL_REFUSED = 'STORE_APPEAL_REFUSED',
  STORE_RESTORED = 'STORE_RESTORED',
  SHOP_VERIFIED = 'SHOP_VERIFIED',
  SHOP_VERIFICATION_REFUSED = 'SHOP_VERIFICATION_REFUSED',
  SHOP_VERIFICATION_REVOKED = 'SHOP_VERIFICATION_REVOKED',
  SMS_SENDER_APPROVED = 'SMS_SENDER_APPROVED',
  SMS_SENDER_REFUSED = 'SMS_SENDER_REFUSED',
  SMS_SENDER_REVOKED = 'SMS_SENDER_REVOKED',
  LISTINGS_TAKEN_DOWN = 'LISTINGS_TAKEN_DOWN',
  RIGHTS_COUNTER_REFUSED = 'RIGHTS_COUNTER_REFUSED',
  LISTINGS_RELEASED = 'LISTINGS_RELEASED',
  STATUS_UPDATE = 'STATUS_UPDATE',
  BROADCAST = 'BROADCAST',
  AUTOMATION = 'AUTOMATION',
  SMS_BROADCAST = 'SMS_BROADCAST',
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
    ORDER_DELIVERY_FAILED: {
      description:
        "A courier tried to deliver a parcel of theirs and couldn't: asked whether to deliver it " +
        'again or call them first, their answer for the shop (COD-08, ADR-388).',
    },
    ORDER_READY_FOR_PICKUP: {
      description:
        'An order they collect is packed and waits for them: where, and what the location tells ' +
        'customers of picking up there (SHP-15, ADR-389).',
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
    ORDER_PART_PAID: {
      description:
        'The shop has part of what their order waits for before it ships, by transfer or as ' +
        'staff recorded it: what came, what is left, and its page (ADR-629).',
    },
    ORDER_CONFIRMATION_REMINDER: {
      description:
        'Their cash-on-delivery order asked again to be confirmed, three hours on without an ' +
        "answer, in the shop's calling hours, with the same buttons and link (ADR-175).",
    },
    ORDER_CONFIRMATION_CALL: {
      description:
        'An automated call in Urdu about their cash-on-delivery order, the reminder to confirm ' +
        "it unanswered for an hour, in the shop's calling hours: pressing 1 confirms it, and 2 " +
        "cancels it, where the shop's order settings call (COD-03, ADR-611).",
    },
    ORDER_PAYMENT_REMINDER: {
      description:
        'Their order still waits for its payment, a day before the shop cancels it unpaid: what ' +
        'it waits for, by when, and its page (ADR-174).',
    },
    RETURN_APPROVED: {
      description:
        'The shop agreed to take back what they asked to return from their order, and will say ' +
        'how to send it: what, and its page (ADR-676).',
    },
    RETURN_DECLINED: {
      description:
        "The shop can't take back what they asked to return from their order: what, why, and " +
        'its page (ADR-676).',
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
    GIFT_CARD: {
      description:
        'A gift card they bought, once its order is paid: what it is worth and its code, which ' +
        'is not kept once sent (CAT-12, ADR-451); the shop cannot turn it off.',
    },
    CHECKOUT_REMINDER: {
      description:
        'A shopper who typed their number at checkout and left without ordering, reminded once ' +
        "with a link back to the items (CHK-12, ADR-393): sent as the shop's checkout recovery " +
        'setting says, which turns it on and off, not here.',
    },
    CHECKOUT_OFFER: {
      description:
        'A shopper reminded of a checkout they left, still without ordering, offered one of the ' +
        "shop's discount codes with the link back to the items, the code applied (CHK-12, " +
        "ADR-426): sent as the shop's checkout recovery setting says, not here.",
    },
    REVIEW_REQUEST: {
      description:
        "A delivered order's customer asked once to rate what it brought, with its page's link " +
        "(MKT-05, ADR-400): sent as many days after delivery as the shop's review settings say, " +
        'which turn it on and off, not here.',
    },
    BACK_IN_STOCK: {
      description:
        'A shopper who asked on the storefront to hear when a sold-out variant is for sale ' +
        "again, told once with its page's link (MKT-04, ADR-429): sent while the shop's back in " +
        'stock automation is on, which turns it on and off, not here.',
    },
    COD_PREPAID: {
      description:
        "A confirmed cash-on-delivery order's customer offered store credit for paying the rest " +
        "online, with its page's link (MKT-04, ADR-432): sent while the shop's COD to prepaid " +
        'automation is on, which turns it on and off, not here.',
    },
    STORE_OPEN: {
      description:
        "A shopper who asked on the closed shop's password page to hear when it opens, told once " +
        "with its storefront's link once it does (ONB-14, ADR-446); the shop cannot turn it off.",
    },
    ONE_TIME_CODE: {
      description:
        'A code to prove their number at checkout (CHK-09), which the shop cannot turn off; the ' +
        'code is not kept once sent.',
    },
    ACCOUNT_CODE: {
      description:
        "A code to sign in to their account on the shop's storefront (CUS-02, ADR-570), which " +
        'the shop cannot turn off; the code is not kept once sent.',
    },
    ERASURE_DONE: {
      description:
        'A shopper who asked from their account for their erasure, told once it is done ' +
        '(CUS-05, ADR-582), which the shop cannot turn off; the message is not kept once sent.',
    },
    STOCK_LOW: {
      description:
        'For the shop: a variant fell to its low-stock threshold for sale online (INV-01), once a ' +
        'spell, until it is stocked above it again.',
    },
    STOCK_OUT: { description: 'For the shop: a variant ran out for sale online (INV-01).' },
    DAILY_SUMMARY: {
      description:
        "For the shop, at its alerts number each morning: the day before's orders and sales, " +
        'parcels delivered and turned back, and cash on delivery still to come (ANL-07, ADR-386).',
    },
    ORDERS_OVERDUE: {
      description:
        'For the shop, at its alerts number: orders have waited for their first call longer than ' +
        'its target, at most once every three hours within its calling hours (COD-05, ADR-680).',
    },
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
    CUSTOMER_REFUSED: {
      description:
        'For staff, at their own numbers: a customer refused a parcel while another order of ' +
        'theirs waits to ship; told to whom that order is given, else to the owners, managers ' +
        'and confirmation agents, to call them first (COD-07, ADR-673).',
    },
    INVOICE_DUE: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        "its plan's next period is invoiced and waits for payment (ADR-169, ADR-195).",
    },
    PAYMENT_OVERDUE: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        "its plan's period ended unpaid, with the days left before it is on Free; sent the day " +
        'it ends, with three days left and with one (BIL-04, ADR-511).',
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
    STORE_EXPORT_READY: {
      description:
        "For the shop's owner, from Hatti and paid by Hatti, by email: the whole store's export " +
        'they asked for is ready to download, and until when (ADR-417).',
    },
    STORE_SUSPENDED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        'Hatti has taken its store down after what shoppers reported, and why (ADR-461).',
    },
    STORE_APPEAL_REFUSED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: Hatti has refused its ' +
        "appeal of its store's takedown, and why (ADR-462).",
    },
    STORE_RESTORED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number and its owner's email: " +
        'its store is open again, and why (ADR-461).',
    },
    SHOP_VERIFIED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: Hatti has verified it ' +
        '(ADR-465).',
    },
    SHOP_VERIFICATION_REFUSED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: Hatti could not verify ' +
        'it, and why (ADR-465).',
    },
    SHOP_VERIFICATION_REVOKED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: Hatti has taken its ' +
        'verification back, and why (ADR-465).',
    },
    SMS_SENDER_APPROVED: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number: its customers' SMS " +
        'now come from its own name (ADR-469).',
    },
    SMS_SENDER_REFUSED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: the name it asked ' +
        'for could not be registered, and why (ADR-469).',
    },
    SMS_SENDER_REVOKED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: its SMS no longer ' +
        "come from its own name, and why; they come from Hatti's shared sender again (ADR-469).",
    },
    LISTINGS_TAKEN_DOWN: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: listings taken off ' +
        'sale after a rights complaint Hatti upheld, who complained and how to reach them (ADR-475).',
    },
    RIGHTS_COUNTER_REFUSED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: its answer to a ' +
        'rights complaint refused, and why; the listings stay held (ADR-476).',
    },
    LISTINGS_RELEASED: {
      description:
        'For the shop, from Hatti and paid by Hatti, at its alerts number: listings held for a ' +
        'rights complaint let go, and why (ADR-476).',
    },
    STATUS_UPDATE: {
      description:
        "For the shop, from Hatti and paid by Hatti, at its alerts number: an outage of Hatti's " +
        'begun, or maintenance putting a part out of service set, and its ending (ADR-544).',
    },
    BROADCAST: {
      description:
        "One of the shop's own broadcasts, from its own WhatsApp number to a customer who agreed " +
        'to hear from it there (ADR-422): never by SMS.',
    },
    AUTOMATION: {
      description:
        "Sent by one of the shop's automations, a welcome or a win-back, from its own WhatsApp " +
        'number to a customer who agreed to hear from it there (ADR-425): never by SMS.',
    },
    SMS_BROADCAST: {
      description:
        "One of the shop's SMS campaigns, its own words from Hatti's shared sender to a customer " +
        'who agreed to hear from it by SMS, with a link to stop (ADR-458).',
    },
  },
});

export enum MessageChannel {
  WHATSAPP = 'WHATSAPP',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
  VOICE = 'VOICE',
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
    VOICE: {
      description:
        "An automated call through Hatti's voice gateway, read out in Urdu, the keys pressed " +
        'its answer (ADR-611).',
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

  @Field(() => String, {
    nullable: true,
    description:
      "Where replies to the shop's emails to its customers go, as their Reply-To: their words " +
      "say a reply reaches the shop. None says replies aren't read.",
  })
  replyToEmail!: string | null;

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

  @Field(() => String, {
    nullable: true,
    description:
      "Where replies to the shop's emails to its customers go: an email address. Null or blank " +
      'leaves replies unread.',
  })
  replyToEmail?: string | null;
}

@ObjectType()
export class MessagingSettingsUpdatePayload {
  @Field(() => MessagingSettings, { nullable: true })
  messagingSettings!: MessagingSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
