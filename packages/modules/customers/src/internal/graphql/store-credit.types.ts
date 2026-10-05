import { Money, MoneyInput, PageInfo, UserError } from '@hatti/api';
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

export enum StoreCreditAccountTransactionKind {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
  DEBIT_REVERT = 'DEBIT_REVERT',
  EXPIRATION = 'EXPIRATION',
}

registerEnumType(StoreCreditAccountTransactionKind, {
  name: 'StoreCreditAccountTransactionKind',
  description:
    "Which way a transaction moved an account's balance: Shopify's transaction types, as one.",
  valuesMap: {
    CREDIT: { description: 'Credit added, which may expire.' },
    DEBIT: { description: 'Credit spent or taken away, the credits that expire soonest first.' },
    DEBIT_REVERT: {
      description:
        'A debit given back, to the credits it came from, as when an order is cancelled.',
    },
    EXPIRATION: { description: 'What a credit had left when it expired.' },
  },
});

export enum StoreCreditSystemEvent {
  ADJUSTMENT = 'ADJUSTMENT',
  ORDER_PAYMENT = 'ORDER_PAYMENT',
  ORDER_REFUND = 'ORDER_REFUND',
  ORDER_CANCELLATION = 'ORDER_CANCELLATION',
}

registerEnumType(StoreCreditSystemEvent, {
  name: 'StoreCreditSystemEvent',
  description: 'Why a transaction was made, as Shopify names it.',
  valuesMap: {
    ADJUSTMENT: { description: 'By hand: storeCreditAccountCredit or storeCreditAccountDebit.' },
    ORDER_PAYMENT: { description: 'It paid for an order.' },
    ORDER_REFUND: { description: "An order's refund, given as store credit." },
    ORDER_CANCELLATION: { description: 'An order it paid for was cancelled.' },
  },
});

@ObjectType({
  description:
    'What the shop owes a customer to spend with it, in one currency (ORD-09, ADR-184), as ' +
    "Shopify's StoreCreditAccount: credited by refunds given as store credit, or by hand.",
})
export class StoreCreditAccount {
  @Field(() => ID)
  id!: string;

  @Field(() => Money, { description: "What its credits have left that hasn't expired." })
  balance!: Money;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  /** For field resolvers. */
  uuid!: string;
  customerUuid!: string;
}

@ObjectType({
  description:
    "A change of a store credit account's balance (ADR-184): Shopify's credit, debit, debit " +
    'revert and expiration transactions, as one type with a kind.',
})
export class StoreCreditAccountTransaction {
  @Field(() => ID)
  id!: string;

  @Field(() => StoreCreditAccountTransactionKind)
  kind!: StoreCreditAccountTransactionKind;

  @Field(() => StoreCreditSystemEvent, {
    nullable: true,
    description: 'Why it was made; null for an expiration, which its kind says.',
  })
  event!: StoreCreditSystemEvent | null;

  @Field(() => Money, {
    description: 'What it added to the balance, or took from it, less than zero.',
  })
  amount!: Money;

  @Field(() => Money)
  balanceAfterTransaction!: Money;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: "A credit's expiry; null when it never expires, and for other kinds.",
  })
  expiresAt!: Date | null;

  @Field(() => Money, {
    nullable: true,
    description: "A credit's: what is left of it to spend; null for other kinds.",
  })
  remainingAmount!: Money | null;

  @Field(() => ID, {
    nullable: true,
    description: 'The order it was for: refunded to store credit, paid with it, or cancelled.',
  })
  orderId!: string | null;

  @Field(() => ID, { nullable: true, description: 'The refund it gave, as store credit.' })
  refundId!: string | null;

  @Field({ description: "For the shop's records." })
  note!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => StoreCreditAccount)
  account!: StoreCreditAccount;
}

@ObjectType()
export class StoreCreditAccountTransactionEdge {
  @Field()
  cursor!: string;

  @Field(() => StoreCreditAccountTransaction)
  node!: StoreCreditAccountTransaction;
}

@ObjectType()
export class StoreCreditAccountTransactionConnection {
  @Field(() => [StoreCreditAccountTransactionEdge])
  edges!: StoreCreditAccountTransactionEdge[];

  @Field(() => [StoreCreditAccountTransaction])
  nodes!: StoreCreditAccountTransaction[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ObjectType()
export class StoreCreditAccountEdge {
  @Field()
  cursor!: string;

  @Field(() => StoreCreditAccount)
  node!: StoreCreditAccount;
}

@ObjectType()
export class StoreCreditAccountConnection {
  @Field(() => [StoreCreditAccountEdge])
  edges!: StoreCreditAccountEdge[];

  @Field(() => [StoreCreditAccount])
  nodes!: StoreCreditAccount[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class StoreCreditPageArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType()
export class StoreCreditAccountCreditInput {
  @Field(() => MoneyInput)
  creditAmount!: MoneyInput;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the credit expires; never, unless given.',
  })
  expiresAt?: Date | null;

  @Field(() => String, { nullable: true, description: "Why, for the shop's records." })
  note?: string | null;
}

@InputType()
export class StoreCreditAccountDebitInput {
  @Field(() => MoneyInput)
  debitAmount!: MoneyInput;

  @Field(() => String, { nullable: true, description: "Why, for the shop's records." })
  note?: string | null;
}

@ObjectType()
export class StoreCreditAccountCreditPayload {
  @Field(() => StoreCreditAccountTransaction, { nullable: true })
  storeCreditAccountTransaction!: StoreCreditAccountTransaction | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class StoreCreditAccountDebitPayload {
  @Field(() => StoreCreditAccountTransaction, { nullable: true })
  storeCreditAccountTransaction!: StoreCreditAccountTransaction | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
