import { Money, UserError } from '@hatti/api';
import { MessageChannelEnum } from '@hatti/messaging/public';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum BillingPlanCode {
  FREE = 'FREE',
  STARTER = 'STARTER',
  GROWTH = 'GROWTH',
  PRO = 'PRO',
}

registerEnumType(BillingPlanCode, {
  name: 'BillingPlanCode',
  description: 'The plans shops pay Hatti for (ADR-154).',
});

export enum BillingInterval {
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
}

registerEnumType(BillingInterval, {
  name: 'BillingInterval',
  description: "How a paid plan is paid for: by the month, or by the year at ten months' price.",
});

export enum BillingInvoiceStatus {
  OPEN = 'OPEN',
  PAID = 'PAID',
  VOID = 'VOID',
}

registerEnumType(BillingInvoiceStatus, {
  name: 'BillingInvoiceStatus',
  valuesMap: {
    OPEN: {
      description:
        "Waiting to be paid, with billingInvoicePay, or by transfer into Hatti's account, said " +
        'with billingInvoiceTransferReport.',
    },
    PAID: {
      description:
        "Paid, through Hatti's gateway or by transfer: its plan runs for the period paid for.",
    },
    VOID: { description: 'No longer due: another choice took its place, or its plan ended.' },
  },
});

export enum BillingInvoiceReason {
  CHANGE = 'CHANGE',
  RENEWAL = 'RENEWAL',
  CREDITS = 'CREDITS',
}

registerEnumType(BillingInvoiceReason, {
  name: 'BillingInvoiceReason',
  valuesMap: {
    CHANGE: { description: 'A plan chosen now: it begins once paid.' },
    RENEWAL: { description: "The plan's next period, invoiced a week before the period ends." },
    CREDITS: {
      description: "Credit for the shop's messages (ADR-155): the shop's once paid.",
    },
  },
});

export enum MessageCategory {
  UTILITY = 'UTILITY',
  AUTHENTICATION = 'AUTHENTICATION',
  MARKETING = 'MARKETING',
}

registerEnumType(MessageCategory, {
  name: 'MessageCategory',
  description: "Meta's category of a WhatsApp template, which prices its messages.",
  valuesMap: {
    UTILITY: { description: 'News of an order its customer placed.' },
    AUTHENTICATION: { description: 'A code to prove a number.' },
    MARKETING: { description: 'What broadcasts will send.' },
  },
});

export enum BillingWalletEntryKind {
  TOP_UP = 'TOP_UP',
  GRANT = 'GRANT',
  MESSAGE = 'MESSAGE',
  MESSAGE_REFUND = 'MESSAGE_REFUND',
}

registerEnumType(BillingWalletEntryKind, {
  name: 'BillingWalletEntryKind',
  valuesMap: {
    TOP_UP: { description: 'Credit bought: its invoice paid.' },
    GRANT: { description: 'Credit Hatti gave.' },
    MESSAGE: { description: 'A message sent, at its price.' },
    MESSAGE_REFUND: {
      description: 'What a WhatsApp message was charged, given back: it could not be delivered.',
    },
  },
});

export enum BillingTransferStatus {
  WAITING = 'WAITING',
  CONFIRMED = 'CONFIRMED',
  REFUSED = 'REFUSED',
}

registerEnumType(BillingTransferStatus, {
  name: 'BillingTransferStatus',
  valuesMap: {
    WAITING: { description: "Waiting for Hatti's people to find it in Hatti's account." },
    CONFIRMED: { description: 'Found: it paid its invoice, or went towards it.' },
    REFUSED: {
      description: 'Not found as the shop said it, for the reason given: another may be said.',
    },
  },
});

@ObjectType({ description: 'A plan shops pay Hatti for, priced in rupees (ADR-154).' })
export class BillingPlan {
  @Field(() => BillingPlanCode)
  code!: BillingPlanCode;

  @Field({ description: 'Such as "Growth".' })
  name!: string;

  @Field(() => Money, { description: 'For a month.' })
  monthlyPrice!: Money;

  @Field(() => Money, { description: "For a year: ten months' price." })
  yearlyPrice!: Money;

  @Field(() => Int, { description: 'Members of staff it has room for, the owner among them.' })
  staffLimit!: number;

  @Field(() => Int, { description: 'Locations it has room for.' })
  locationLimit!: number;

  @Field(() => Int, {
    nullable: true,
    description: 'Orders a month it is meant for; null for any number. Not enforced yet.',
  })
  orderLimit!: number | null;
}

@ObjectType({
  description: "An invoice of Hatti's to the shop, for a plan's period or for message credit.",
})
export class BillingInvoice {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Its number across Hatti, as printed: "HB-000123".' })
  name!: string;

  @Field(() => BillingInvoiceReason)
  reason!: BillingInvoiceReason;

  @Field(() => BillingPlan, {
    nullable: true,
    description: 'The plan it pays for; null for credit.',
  })
  plan!: BillingPlan | null;

  @Field(() => BillingInterval, { nullable: true })
  interval!: BillingInterval | null;

  @Field(() => Money, { description: "The plan's price for the period, or the credit bought." })
  price!: Money;

  @Field(() => Money, {
    description: 'What was left unused of the period the plan cut short, taken off.',
  })
  credit!: Money;

  @Field(() => Money, { description: 'What is owed: price less credit.' })
  amount!: Money;

  @Field(() => BillingInvoiceStatus)
  status!: BillingInvoiceStatus;

  @Field(() => String, {
    nullable: true,
    description:
      "The reference of the payment that paid it: the gateway's, or the transfer's as the owner " +
      'gave it.',
  })
  reference!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  paidAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  /** Its UUID, for the transfers said for it; not in the schema. */
  uuid!: string;
}

@ObjectType({
  description:
    "Hatti's own bank account, which invoices are paid into by transfer or Raast (ADR-254).",
})
export class BillingBankAccount {
  @Field({ description: "The account's title, as its bank shows it." })
  title!: string;

  @Field()
  bankName!: string;

  @Field({ description: 'Unspaced: "PK36SCBL0000001123456702".' })
  iban!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The mobile number its bank registered for Raast, E.164; null for none.',
  })
  raastId!: string | null;
}

@ObjectType({
  description: "A transfer the shop said it made for an invoice, into Hatti's account (ADR-254).",
})
export class BillingInvoiceTransfer {
  @Field(() => ID)
  id!: string;

  @Field({ description: "The bank's or Raast's reference for it, as the owner gave it." })
  reference!: string;

  @Field(() => Money, { description: 'What the invoice asked for when it was said.' })
  amount!: Money;

  @Field(() => BillingTransferStatus)
  status!: BillingTransferStatus;

  @Field(() => Money, {
    nullable: true,
    description: "What Hatti's people found in its account, once confirmed.",
  })
  received!: Money | null;

  @Field(() => String, { nullable: true, description: "Why Hatti's people refused it." })
  refusal!: string | null;

  @Field(() => GraphQLISODateTime)
  reportedAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: "When Hatti's people confirmed or refused it.",
  })
  checkedAt!: Date | null;
}

@ObjectType()
export class BillingInvoiceTransferReportPayload {
  @Field(() => BillingInvoiceTransfer, { nullable: true })
  transfer!: BillingInvoiceTransfer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({ description: 'The plan the shop pays Hatti for; Free until it chooses another.' })
export class BillingSubscription {
  @Field(() => BillingPlan)
  plan!: BillingPlan;

  @Field(() => BillingInterval, { nullable: true, description: 'Null on Free.' })
  interval!: BillingInterval | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'The period paid for.' })
  periodStart!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  periodEnd!: Date | null;

  @Field({
    description:
      'The period ended unpaid: the plan stays for a week, then the shop is on Free until its ' +
      'invoice is paid.',
  })
  pastDue!: boolean;

  @Field(() => BillingPlan, {
    nullable: true,
    description: 'A smaller plan, or Free, chosen to begin when the period ends.',
  })
  nextPlan!: BillingPlan | null;

  @Field(() => BillingInterval, { nullable: true })
  nextInterval!: BillingInterval | null;

  @Field(() => BillingInvoice, { nullable: true, description: 'The invoice waiting to be paid.' })
  openInvoice!: BillingInvoice | null;
}

@InputType()
export class BillingPlanChangeInput {
  @Field(() => BillingPlanCode)
  plan!: BillingPlanCode;

  @Field(() => BillingInterval, {
    nullable: true,
    description: 'Required for a paid plan; none for Free.',
  })
  interval?: BillingInterval | null;
}

@ObjectType()
export class BillingPlanChangePayload {
  @Field(() => BillingSubscription, { nullable: true })
  subscription!: BillingSubscription | null;

  @Field(() => BillingInvoice, {
    nullable: true,
    description: 'For a plan that begins now: what to pay, with billingInvoicePay.',
  })
  invoice!: BillingInvoice | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class BillingInvoicePayPayload {
  @Field(() => String, {
    nullable: true,
    description:
      "Hatti's gateway's page to send the owner to; it sends them back to the invoice's page.",
  })
  checkoutUrl!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description: "What a message costs the shop (ADR-155): what it costs Hatti, and Hatti's fee.",
})
export class BillingMessagePrice {
  @Field(() => MessageChannelEnum)
  channel!: MessageChannelEnum;

  @Field(() => MessageCategory)
  category!: MessageCategory;

  @Field(() => Money, {
    description:
      'For a WhatsApp message, or for each part of an SMS: 160 characters, or 70 in Urdu.',
  })
  price!: Money;
}

@ObjectType({ description: "The credit the shop's messages are paid from (ADR-155)." })
export class BillingWallet {
  @Field(() => Money, {
    description:
      'Below zero only when messages sent at once took more than it held: credit bought next ' +
      'pays for them first. Messages wait while it cannot pay for them.',
  })
  balance!: Money;

  @Field(() => BillingInvoice, {
    nullable: true,
    description: 'Credit chosen to buy, waiting to be paid with billingInvoicePay.',
  })
  openInvoice!: BillingInvoice | null;
}

@ObjectType({ description: "A change to the shop's message credit." })
export class BillingWalletEntry {
  @Field(() => ID)
  id!: string;

  @Field(() => BillingWalletEntryKind)
  kind!: BillingWalletEntryKind;

  @Field(() => Money, { description: 'Added; below zero when taken for a message.' })
  amount!: Money;

  @Field(() => Money, { description: 'What the credit held after it.' })
  balance!: Money;

  @Field(() => ID, { nullable: true, description: 'The invoice whose payment bought it.' })
  invoiceId!: string | null;

  @Field(() => ID, { nullable: true, description: 'The message paid for, as messages lists it.' })
  messageId!: string | null;

  @Field(() => MessageChannelEnum, { nullable: true })
  channel!: MessageChannelEnum | null;

  @Field(() => MessageCategory, { nullable: true })
  category!: MessageCategory | null;

  @Field(() => Int, { nullable: true, description: "An SMS's parts, each priced." })
  parts!: number | null;

  @Field(() => String, { nullable: true, description: 'Why Hatti gave it.' })
  note!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@InputType()
export class BillingCreditsBuyInput {
  @Field({ description: 'How much, in whole rupees, like "1000": Rs 500 to Rs 100,000.' })
  amount!: string;
}

@ObjectType()
export class BillingCreditsBuyPayload {
  @Field(() => BillingInvoice, {
    nullable: true,
    description: 'What to pay, with billingInvoicePay.',
  })
  invoice!: BillingInvoice | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
