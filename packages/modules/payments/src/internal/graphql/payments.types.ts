import { Money, UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum PaymentGatewayEnvironment {
  SANDBOX = 'SANDBOX',
  PRODUCTION = 'PRODUCTION',
}

registerEnumType(PaymentGatewayEnvironment, {
  name: 'PaymentGatewayEnvironment',
  description: "Which of a gateway's environments an account takes payments in.",
  valuesMap: {
    SANDBOX: {
      description:
        "The gateway's test environment: its payments move no money, so they pay no order.",
    },
    PRODUCTION: { description: 'The real one.' },
  },
});

export enum PaymentSessionStatus {
  OPEN = 'OPEN',
  PAID = 'PAID',
  FAILED = 'FAILED',
}

registerEnumType(PaymentSessionStatus, {
  name: 'PaymentSessionStatus',
  description: 'What became of a payment the customer started online.',
  valuesMap: {
    OPEN: { description: 'Started: the gateway has not said it is paid.' },
    PAID: { description: 'The gateway said it is paid; what the order owed of it is paid on it.' },
    FAILED: { description: 'The gateway would not start it: see error.' },
  },
});

export enum PaymentGatewayRefunds {
  NONE = 'NONE',
  WHOLE = 'WHOLE',
  PARTIAL = 'PARTIAL',
}

registerEnumType(PaymentGatewayRefunds, {
  name: 'PaymentGatewayRefunds',
  description:
    'What of a payment a gateway gives back through Hatti, by orderRefund with ONLINE (ADR-153).',
  valuesMap: {
    NONE: { description: "Nothing: refund in the gateway's dashboard, then record it." },
    WHOLE: { description: 'A payment whole, as it was paid; part of one in its dashboard.' },
    PARTIAL: { description: 'Any part of a payment.' },
  },
});

export enum PaymentRefundStatus {
  PENDING = 'PENDING',
  REFUNDED = 'REFUNDED',
  REFUSED = 'REFUSED',
  UNKNOWN = 'UNKNOWN',
}

registerEnumType(PaymentRefundStatus, {
  name: 'PaymentRefundStatus',
  description: 'What became of money asked back of a payment through its gateway.',
  valuesMap: {
    PENDING: {
      description:
        'The gateway is being asked. Past a few minutes, its answer was lost: settle it with ' +
        'paymentRefundSettle.',
    },
    REFUNDED: { description: "Given back: the order's refund records it." },
    REFUSED: { description: 'The gateway would not give it back: see error.' },
    UNKNOWN: {
      description:
        "The gateway did not answer, so it may have given it back: check the gateway's " +
        'dashboard, then settle it with paymentRefundSettle. It holds its amount meanwhile.',
    },
  },
});

export enum PaymentConfirmation {
  RETURN = 'RETURN',
  WEBHOOK = 'WEBHOOK',
  INQUIRY = 'INQUIRY',
}

registerEnumType(PaymentConfirmation, {
  name: 'PaymentConfirmation',
  description: 'How Hatti heard that a payment is made, signed by the gateway each way.',
  valuesMap: {
    RETURN: { description: 'The customer came back from the gateway with it.' },
    WEBHOOK: { description: "The gateway's webhook said so." },
    INQUIRY: {
      description:
        'Asked after, as the customer never came back, the gateway said so (ADR-208), as ' +
        "JazzCash's status inquiry does.",
    },
  },
});

@ObjectType({ description: 'A credential a payment gateway asks for, as its dashboard shows it.' })
export class PaymentGatewayCredentialField {
  @Field({ description: 'What it goes by in PaymentGatewayCredentialInput, such as "apiKey".' })
  key!: string;

  @Field({ description: 'As staff know it, such as "API key".' })
  label!: string;
}

@ObjectType({ description: 'A payment gateway shops take payments online through (PAY-01).' })
export class PaymentGateway {
  @Field({ description: 'Its key, such as "safepay".' })
  gateway!: string;

  @Field({ description: 'Its name, such as "Safepay".' })
  name!: string;

  @Field(() => [PaymentGatewayCredentialField], {
    description: 'What connecting an account asks for.',
  })
  credentials!: PaymentGatewayCredentialField[];

  @Field(() => [String], { description: 'The currencies it takes, such as ["PKR", "USD"].' })
  currencies!: string[];

  @Field({ description: 'Takes nothing from anyone: development and tests only.' })
  test!: boolean;

  @Field(() => PaymentGatewayRefunds, {
    description: 'What of a payment it gives back through Hatti (ADR-153).',
  })
  refunds!: PaymentGatewayRefunds;
}

@ObjectType({
  description:
    "The shop's own account with a payment gateway (PAY-01): payments settle to the shop, " +
    'never through Hatti. Its credentials are never shown. One live account a gateway.',
})
export class PaymentGatewayAccount {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The gateway\'s key, such as "safepay".' })
  gateway!: string;

  @Field({ description: 'Such as "Safepay".' })
  gatewayName!: string;

  @Field(() => PaymentGatewayEnvironment)
  environment!: PaymentGatewayEnvironment;

  @Field({ description: "The last four characters of the account's first credential." })
  credentialsHint!: string;

  @Field({
    description:
      "Where the gateway sends its webhooks for the account: add it in the gateway's " +
      'dashboard, so payments are recorded even when customers do not come back.',
  })
  webhookUrl!: string;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'No new payments through it since; those made still count.',
  })
  archivedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class PaymentGatewayCredentialInput {
  @Field({ description: "The credential's key, as PaymentGateway.credentials lists it." })
  key!: string;

  @Field({ description: 'As the gateway gave it.' })
  value!: string;
}

@InputType()
export class PaymentGatewayAccountInput {
  @Field(() => String, {
    nullable: true,
    description: 'The gateway, by its key, such as "safepay"; connecting only.',
  })
  gateway?: string | null;

  @Field(() => PaymentGatewayEnvironment, {
    nullable: true,
    description: 'PRODUCTION unless given. A new one needs its own credentials.',
  })
  environment?: PaymentGatewayEnvironment | null;

  @Field(() => [PaymentGatewayCredentialInput], {
    nullable: true,
    description: 'All the gateway asks for: replacing them replaces every one.',
  })
  credentials?: PaymentGatewayCredentialInput[] | null;
}

@ObjectType()
export class PaymentGatewayAccountPayload {
  @Field(() => PaymentGatewayAccount, { nullable: true })
  paymentGatewayAccount!: PaymentGatewayAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'Money asked back of a payment through its gateway (PAY-06, ADR-153), by orderRefund with ' +
    'ONLINE.',
})
export class PaymentRefund {
  @Field(() => ID)
  id!: string;

  @Field(() => Money)
  amount!: Money;

  @Field(() => PaymentRefundStatus)
  status!: PaymentRefundStatus;

  @Field(() => String, {
    nullable: true,
    description:
      "The gateway's reference for it once refunded; the payment's own name for it when the " +
      'gateway gives none.',
  })
  reference!: string | null;

  @Field(() => ID, {
    nullable: true,
    description: "The order's refund it was written as, once refunded.",
  })
  refundId!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Why the gateway refused it, or why no answer came.',
  })
  error!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({
  description:
    "A payment the customer started online from their order's page (PAY-04), through the " +
    "shop's gateway account, for what the order waited for then.",
})
export class PaymentSession {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  orderId!: string;

  @Field(() => ID)
  accountId!: string;

  @Field({ description: 'Such as "Safepay".' })
  gatewayName!: string;

  @Field(() => PaymentGatewayEnvironment)
  environment!: PaymentGatewayEnvironment;

  @Field(() => Money, { description: 'What the customer was asked to pay.' })
  amount!: Money;

  @Field(() => PaymentSessionStatus)
  status!: PaymentSessionStatus;

  @Field(() => String, {
    nullable: true,
    description: "The gateway's name for the payment, such as Safepay's tracker.",
  })
  gatewayRef!: string | null;

  @Field(() => Money, { nullable: true, description: 'What was paid, as the gateway said.' })
  paidAmount!: Money | null;

  @Field(() => Money, {
    nullable: true,
    description:
      'What of it was paid on the order: at most what it owed; nothing for a sandbox payment. ' +
      "The rest is on the order's timeline, to give back.",
  })
  applied!: Money | null;

  @Field(() => String, { nullable: true, description: "The gateway's reference for the payment." })
  reference!: string | null;

  @Field(() => PaymentConfirmation, { nullable: true })
  paidThrough!: PaymentConfirmation | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  paidAt!: Date | null;

  @Field(() => String, { nullable: true, description: 'Why the gateway would not start it.' })
  error!: string | null;

  @Field(() => [PaymentRefund], {
    description: 'What was asked back of it through the gateway, the oldest first.',
  })
  refunds!: PaymentRefund[];

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class PaymentRefundSettleInput {
  @Field({ description: "Whether the gateway's dashboard shows it given back." })
  refunded!: boolean;

  @Field(() => String, {
    nullable: true,
    description: "The gateway's reference for it, as its dashboard shows it, when given back.",
  })
  reference?: string | null;
}

@ObjectType()
export class PaymentRefundSettlePayload {
  @Field(() => PaymentRefund, { nullable: true })
  paymentRefund!: PaymentRefund | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
