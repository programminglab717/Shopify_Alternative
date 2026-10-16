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

export enum GiftCardTransactionKind {
  ISSUE = 'ISSUE',
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
  DEBIT_REVERT = 'DEBIT_REVERT',
}

registerEnumType(GiftCardTransactionKind, {
  name: 'GiftCardTransactionKind',
  description: "Which way a transaction moved a gift card's balance (ADR-448).",
  valuesMap: {
    ISSUE: { description: 'What the card was issued for.' },
    CREDIT: { description: 'Added by hand: giftCardCredit.' },
    DEBIT: { description: 'Spent on an order, or taken by hand: giftCardDebit.' },
    DEBIT_REVERT: { description: 'A debit given back, as when the order it paid is cancelled.' },
  },
});

@ObjectType({
  description:
    "A code worth an amount at the shop (CAT-12, PAY-13, ADR-448), as Shopify's GiftCard: " +
    'whoever has the code spends it until its balance is used up, it expires, or the shop ' +
    'deactivates it. The shop keeps no copy of the code, only its last characters.',
})
export class GiftCard {
  @Field(() => ID)
  id!: string;

  @Field({ description: "The code's last four characters, to tell it by." })
  lastCharacters!: string;

  @Field({ description: 'The code as it may be shown: "•••• •••• •••• NPQR".' })
  maskedCode!: string;

  @Field(() => Money)
  initialValue!: Money;

  @Field(() => Money)
  balance!: Money;

  @Field(() => String, {
    nullable: true,
    description: "The last day it can be spent, in the shop's time zone: YYYY-MM-DD.",
  })
  expiresOn!: string | null;

  @Field({ description: 'Past its last day.' })
  expired!: boolean;

  @Field({ description: 'Not deactivated. A card deactivated is so for good.' })
  enabled!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  deactivatedAt!: Date | null;

  @Field({ description: "For the shop's records." })
  note!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  /** For field resolvers. */
  uuid!: string;
  customerUuid!: string | null;
}

@ObjectType({ description: "A change of a gift card's balance (ADR-448)." })
export class GiftCardTransaction {
  @Field(() => ID)
  id!: string;

  @Field(() => GiftCardTransactionKind)
  kind!: GiftCardTransactionKind;

  @Field(() => Money, {
    description: 'What it added to the balance, or took from it, less than zero.',
  })
  amount!: Money;

  @Field(() => Money)
  balanceAfterTransaction!: Money;

  @Field(() => ID, {
    nullable: true,
    description: 'The order it paid, or whose cancellation gave it back.',
  })
  orderId!: string | null;

  @Field({ description: "For the shop's records." })
  note!: string;

  @Field(() => GraphQLISODateTime)
  processedAt!: Date;
}

@ObjectType()
export class GiftCardTransactionEdge {
  @Field()
  cursor!: string;

  @Field(() => GiftCardTransaction)
  node!: GiftCardTransaction;
}

@ObjectType()
export class GiftCardTransactionConnection {
  @Field(() => [GiftCardTransactionEdge])
  edges!: GiftCardTransactionEdge[];

  @Field(() => [GiftCardTransaction])
  nodes!: GiftCardTransaction[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ObjectType()
export class GiftCardEdge {
  @Field()
  cursor!: string;

  @Field(() => GiftCard)
  node!: GiftCard;
}

@ObjectType()
export class GiftCardConnection {
  @Field(() => [GiftCardEdge])
  edges!: GiftCardEdge[];

  @Field(() => [GiftCard])
  nodes!: GiftCard[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class GiftCardPageArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ArgsType()
export class GiftCardsArgs extends GiftCardPageArgs {
  @Field(() => String, {
    nullable: true,
    description: "The code's last characters, as read off the card: those whose code ends so.",
  })
  query?: string | null;
}

@InputType()
export class GiftCardCreateInput {
  @Field({ description: 'What it is worth, in the shop\'s currency: "5000" or "2499.50".' })
  initialValue!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The shop’s own code, 8 to 20 letters and digits; one of 16 is made if left out.',
  })
  code?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "The last day it can be spent, YYYY-MM-DD in the shop's time zone; never if left out.",
  })
  expiresOn?: string | null;

  @Field(() => ID, { nullable: true, description: 'The customer it is given to, if any.' })
  customerId?: string | null;

  @Field(() => String, { nullable: true, description: "For the shop's records." })
  note?: string | null;
}

@InputType({ description: 'Fields left out stay as they are; null takes one away.' })
export class GiftCardUpdateInput {
  @Field(() => String, { nullable: true })
  expiresOn?: string | null;

  @Field(() => ID, { nullable: true })
  customerId?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;
}

@InputType()
export class GiftCardCreditInput {
  @Field(() => MoneyInput)
  creditAmount!: MoneyInput;

  @Field(() => String, { nullable: true, description: "Why, for the shop's records." })
  note?: string | null;
}

@InputType()
export class GiftCardDebitInput {
  @Field(() => MoneyInput)
  debitAmount!: MoneyInput;

  @Field(() => String, { nullable: true, description: "Why, for the shop's records." })
  note?: string | null;
}

@ObjectType()
export class GiftCardCreatePayload {
  @Field(() => GiftCard, { nullable: true })
  giftCard!: GiftCard | null;

  @Field(() => String, {
    nullable: true,
    description: 'The whole code, in groups of four: given this once, and never again.',
  })
  giftCardCode!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class GiftCardPayload {
  @Field(() => GiftCard, { nullable: true })
  giftCard!: GiftCard | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class GiftCardTransactionPayload {
  @Field(() => GiftCardTransaction, { nullable: true })
  giftCardTransaction!: GiftCardTransaction | null;

  @Field(() => GiftCard, { nullable: true })
  giftCard!: GiftCard | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
