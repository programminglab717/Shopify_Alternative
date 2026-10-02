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
    OPEN: { description: 'Waiting to be paid, with billingInvoicePay.' },
    PAID: { description: "Paid through Hatti's gateway: its plan runs for the period paid for." },
    VOID: { description: 'No longer due: another choice took its place, or its plan ended.' },
  },
});

export enum BillingInvoiceReason {
  CHANGE = 'CHANGE',
  RENEWAL = 'RENEWAL',
}

registerEnumType(BillingInvoiceReason, {
  name: 'BillingInvoiceReason',
  valuesMap: {
    CHANGE: { description: 'A plan chosen now: it begins once paid.' },
    RENEWAL: { description: "The plan's next period, invoiced a week before the period ends." },
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

@ObjectType({ description: "An invoice of Hatti's to the shop, for a plan's period." })
export class BillingInvoice {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Its number across Hatti, as printed: "HB-000123".' })
  name!: string;

  @Field(() => BillingInvoiceReason)
  reason!: BillingInvoiceReason;

  @Field(() => BillingPlan)
  plan!: BillingPlan;

  @Field(() => BillingInterval)
  interval!: BillingInterval;

  @Field(() => Money, { description: "The plan's price for the period." })
  price!: Money;

  @Field(() => Money, {
    description: 'What was left unused of the period the plan cut short, taken off.',
  })
  credit!: Money;

  @Field(() => Money, { description: 'What is owed: price less credit.' })
  amount!: Money;

  @Field(() => BillingInvoiceStatus)
  status!: BillingInvoiceStatus;

  @Field(() => String, { nullable: true, description: "The gateway's reference for its payment." })
  reference!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  paidAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
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
