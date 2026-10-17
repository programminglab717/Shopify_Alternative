import { Money, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum PaymentSettlementOutcome {
  MATCHED = 'matched',
  DIFFERS = 'differs',
  UNMATCHED = 'unmatched',
  REPEATED = 'repeated',
  REFUND = 'refund',
}

registerEnumType(PaymentSettlementOutcome, {
  name: 'PaymentSettlementOutcome',
  description:
    "What became of a settlement's line (ADR-491): MATCHED a payment for what the gateway " +
    'settled; DIFFERS a payment for another amount; UNMATCHED no payment of the account; ' +
    'REPEATED a payment settled before; REFUND money the gateway took back.',
});

@ObjectType({ description: "A line of a gateway's settlement: one payment it paid over." })
export class PaymentSettlementLine {
  @Field(() => Int, { description: 'Its row in the file.' })
  row!: number;

  @Field({ description: "The gateway's reference for the payment, as the statement writes it." })
  transactionRef!: string;

  @Field(() => ID, { nullable: true, description: 'The order of the payment it matched.' })
  orderId!: string | null;

  @Field(() => PaymentSettlementOutcome)
  outcome!: PaymentSettlementOutcome;

  @Field(() => Money, { description: 'What the customer paid; less than 0 for a refund.' })
  gross!: Money;

  @Field(() => Money)
  fees!: Money;

  @Field(() => Money, { description: 'The tax the gateway withheld.' })
  tax!: Money;

  @Field(() => Money, { nullable: true, description: 'What the payment it matched was for.' })
  paid!: Money | null;
}

@ObjectType({
  description:
    "A gateway's settlement statement the shop imported (PAY-07, ADR-491): what it paid over, " +
    'less its fees and the tax it withheld.',
})
export class PaymentSettlement {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  accountId!: string;

  @Field({ description: "The account's gateway, such as safepay." })
  gateway!: string;

  @Field(() => String, { nullable: true })
  reference!: string | null;

  @Field(() => Int)
  lineCount!: number;

  @Field(() => Money, { description: 'What customers paid, less refunds taken back.' })
  gross!: Money;

  @Field(() => Money)
  fees!: Money;

  @Field(() => Money, { description: 'The tax the gateway withheld.' })
  tax!: Money;

  @Field(() => Money, { description: 'What the gateway paid over.' })
  net!: Money;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class PaymentSettlementOutcomeCounts {
  @Field(() => Int)
  matched!: number;

  @Field(() => Int)
  differs!: number;

  @Field(() => Int)
  unmatched!: number;

  @Field(() => Int)
  repeated!: number;

  @Field(() => Int)
  refund!: number;
}

@ObjectType()
export class PaymentSettlementRowError {
  @Field(() => Int)
  row!: number;

  @Field(() => String, { nullable: true })
  column!: string | null;

  @Field()
  message!: string;
}

@ObjectType()
export class PaymentSettlementImportPayload {
  @Field(() => PaymentSettlement, { nullable: true, description: 'Null on a dry run.' })
  settlement!: PaymentSettlement | null;

  @Field(() => Int, { description: 'Rows after the header.' })
  rows!: number;

  @Field(() => PaymentSettlementOutcomeCounts)
  outcomes!: PaymentSettlementOutcomeCounts;

  @Field(() => Money)
  gross!: Money;

  @Field(() => Money)
  fees!: Money;

  @Field(() => Money)
  tax!: Money;

  @Field(() => Money)
  net!: Money;

  @Field(() => [PaymentSettlementLine], {
    description: 'The first 250 lines to look into: those not matched, or not settled in full.',
  })
  issues!: PaymentSettlementLine[];

  @Field(() => [PaymentSettlementRowError])
  rowErrors!: PaymentSettlementRowError[];

  @Field(() => Int)
  rowErrorCount!: number;

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
