import { Money, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { RefundReceiptRecord } from '../records.js';

export enum TransferReceiptReadOutcome {
  READ = 'READ',
  NOT_A_RECEIPT = 'NOT_A_RECEIPT',
  FAILED = 'FAILED',
}

registerEnumType(TransferReceiptReadOutcome, {
  name: 'TransferReceiptReadOutcome',
  description: 'What came of reading a receipt with the AI (PAY-08, ADR-845).',
  valuesMap: {
    READ: { description: 'It was read: what it says is given.' },
    NOT_A_RECEIPT: { description: "It isn't a receipt for a sent payment." },
    FAILED: { description: 'The AI could not read it: it may be read again.' },
  },
});

export enum TransferReceiptAmountCheck {
  MATCHES = 'MATCHES',
  SHORT = 'SHORT',
  OVER = 'OVER',
  UNKNOWN = 'UNKNOWN',
}

registerEnumType(TransferReceiptAmountCheck, {
  name: 'TransferReceiptAmountCheck',
  description: 'How the amount a receipt says compares with what its order waited for then.',
  valuesMap: {
    MATCHES: { description: 'The same.' },
    SHORT: { description: 'Less than it waited for.' },
    OVER: { description: 'More than it waited for.' },
    UNKNOWN: { description: 'No amount was read, or the order waited for nothing then.' },
  },
});

export enum TransferReceiptAccountCheck {
  MATCHES = 'MATCHES',
  DIFFERS = 'DIFFERS',
  UNKNOWN = 'UNKNOWN',
}

registerEnumType(TransferReceiptAccountCheck, {
  name: 'TransferReceiptAccountCheck',
  description: 'Whether a receipt says the money went to the account its customer was told.',
  valuesMap: {
    MATCHES: {
      description:
        "Its account's last digits end the account's IBAN or Raast ID, or, with no digits " +
        "shown, its name is the account's title.",
    },
    DIFFERS: { description: "Its account's last digits are another account's." },
    UNKNOWN: { description: 'It shows too little to tell, or the order was told no account.' },
  },
});

@ObjectType({
  description:
    'What a receipt says, as the AI read it, and what Hatti makes of it (PAY-08, ADR-845). The ' +
    'AI saw the receipt alone. A reading never marks an order paid: staff confirm the payment ' +
    'themselves.',
})
export class TransferReceiptReading {
  @Field(() => TransferReceiptReadOutcome)
  outcome!: TransferReceiptReadOutcome;

  @Field(() => GraphQLISODateTime)
  readAt!: Date;

  @Field(() => Money, { nullable: true, description: 'The money it says was sent.' })
  amount!: Money | null;

  @Field(() => String, {
    nullable: true,
    description: 'The day it says the money was sent: "2026-10-20".',
  })
  paidOn!: string | null;

  @Field(() => String, { nullable: true, description: "The transaction's own reference." })
  reference!: string | null;

  @Field(() => String, { nullable: true })
  senderName!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'The bank or wallet it was sent from: "Meezan Bank", "JazzCash".',
  })
  senderBank!: string | null;

  @Field(() => String, { nullable: true })
  recipientName!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'The account it says the money went to, as it shows it, masked or whole.',
  })
  recipientAccount!: string | null;

  @Field(() => Money, {
    nullable: true,
    description: 'What its order waited for by transfer when it was read.',
  })
  owed!: Money | null;

  @Field(() => TransferReceiptAmountCheck, { nullable: true })
  amountCheck!: TransferReceiptAmountCheck | null;

  @Field(() => TransferReceiptAccountCheck, { nullable: true })
  accountCheck!: TransferReceiptAccountCheck | null;

  @Field(() => [String], {
    description:
      'The shop\'s other orders with a receipt of the same reference, as "#1023": the same ' +
      'transfer sent for more than one order.',
  })
  sameReferenceOrders!: string[];

  @Field({
    description: 'Whether the day it says the money was sent is before its order was placed.',
  })
  beforeOrder!: boolean;
}

@ObjectType()
export class TransferReceiptReadPayload {
  @Field(() => TransferReceiptReading, { nullable: true })
  reading!: TransferReceiptReading | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "A receipt for a bank transfer, which the customer sent through their order's page: a " +
    'photo, a screenshot or a PDF (ADR-080).',
})
export class TransferReceipt {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'image/jpeg, image/png, image/webp or application/pdf.' })
  mimeType!: string;

  @Field(() => Int, { description: 'Bytes.' })
  fileSize!: number;

  @Field({
    description:
      'Where it is shown, for an hour from when it was asked for, named for its order: ' +
      '"Receipt #1023-1.jpg".',
  })
  url!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  /** Its own ID, for its reading. */
  uuid!: string;
}

@ObjectType({
  description:
    "A refund's receipt, which staff kept of the money they sent back by hand: a photo, a " +
    'screenshot or a PDF (ADR-242).',
})
export class RefundReceipt {
  @Field({ description: 'image/jpeg, image/png, image/webp or application/pdf.' })
  mimeType!: string;

  @Field(() => Int, { description: 'Bytes.' })
  fileSize!: number;

  /** Where storage keeps it, and what its URL names it for: its order and its refund's place. */
  record!: RefundReceiptRecord;
  orderNumber!: number;
  position!: number;
}
