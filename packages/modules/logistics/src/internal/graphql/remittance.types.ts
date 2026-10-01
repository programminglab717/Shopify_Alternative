import { Money, PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { STATEMENT_LIMITS } from '../statement.js';

export enum CodRemittanceOutcome {
  RECEIVED = 'RECEIVED',
  SHORT = 'SHORT',
  OVER = 'OVER',
  UNMATCHED = 'UNMATCHED',
  REPEATED = 'REPEATED',
  NOT_OWED = 'NOT_OWED',
  CHARGED = 'CHARGED',
  COMPENSATED = 'COMPENSATED',
}

registerEnumType(CodRemittanceOutcome, {
  name: 'CodRemittanceOutcome',
  description: "What became of a line of a courier's remittance statement.",
  valuesMap: {
    RECEIVED: { description: 'Its cash was what the order owed, and was received on it.' },
    SHORT: {
      description: 'Less than the order owed: what came was received, and the rest is owed still.',
    },
    OVER: { description: 'More than the order owed: what it owed was received, and no more.' },
    UNMATCHED: { description: 'No parcel of the shop has its tracking number.' },
    REPEATED: {
      description:
        'The parcel came before, in this statement or with cash in an earlier one: nothing ' +
        'was received, so that a statement imported twice is not received twice.',
    },
    NOT_OWED: {
      description:
        'Cash for an order that owes none, or is not open cash on delivery: nothing was received.',
    },
    CHARGED: {
      description:
        "No cash, only the courier's charges, on an order that owes none, as for a parcel sent " +
        'back.',
    },
    COMPENSATED: {
      description:
        "Cash for a parcel the courier lost: it paid the parcel's claim, filed or not. Cash for " +
        'one whose claim was paid otherwise, or withdrawn, is NOT_OWED.',
    },
  },
});

@ObjectType({ description: "A line of a courier's remittance statement, and what became of it." })
export class CodRemittanceLine {
  @Field(() => Int, { description: 'Its row in the file; the header is row 1.' })
  row!: number;

  @Field({ description: 'As the statement writes it.' })
  trackingNumber!: string;

  @Field(() => CodRemittanceOutcome)
  outcome!: CodRemittanceOutcome;

  @Field(() => ID, { nullable: true, description: 'The parcel it matched.' })
  fulfillmentId!: string | null;

  @Field(() => ID, { nullable: true, description: "The parcel's order." })
  orderId!: string | null;

  @Field(() => String, { nullable: true, description: 'The order\'s name, such as "#1005".' })
  orderName!: string | null;

  @Field(() => Money, { description: 'The cash the courier collected on the parcel.' })
  collected!: Money;

  @Field(() => Money)
  charges!: Money;

  @Field(() => Money, { description: 'Withheld by the courier.' })
  tax!: Money;

  @Field(() => Money, {
    nullable: true,
    description: 'What the order still owed as the line was taken; none for a line unmatched.',
  })
  owed!: Money | null;

  @Field(() => Money, { description: 'What of its cash was received on the order.' })
  received!: Money;
}

@ObjectType({
  description:
    "A courier's remittance statement (COD-10): the cash it paid over for parcels, each line " +
    "matched to a parcel by its tracking number and its cash received on the parcel's order.",
})
export class CodRemittance {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'As staff named it when importing.' })
  courier!: string;

  @Field(() => String, {
    nullable: true,
    description: "The statement's number or the payment's reference.",
  })
  reference!: string | null;

  @Field(() => Int)
  lineCount!: number;

  @Field(() => Money, { description: "The cash the courier collected on the statement's parcels." })
  collected!: Money;

  @Field(() => Money)
  charges!: Money;

  @Field(() => Money, { description: 'Withheld by the courier.' })
  tax!: Money;

  @Field(() => Money, {
    description:
      "What the courier paid over: the statement's net amounts, else collected less charges " +
      'and tax.',
  })
  paid!: Money;

  @Field(() => Money, { description: 'What of the cash was received on orders.' })
  received!: Money;

  @Field(() => Money, {
    description: 'What of the cash paid claims for parcels the courier lost (COMPENSATED lines).',
  })
  compensated!: Money;

  @Field(() => Int, {
    description:
      'Lines to look into: all but those received in full, charges alone, and claims paid.',
  })
  issueCount!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class CodRemittanceEdge {
  @Field()
  cursor!: string;

  @Field(() => CodRemittance)
  node!: CodRemittance;
}

@ObjectType()
export class CodRemittanceConnection {
  @Field(() => [CodRemittanceEdge])
  edges!: CodRemittanceEdge[];

  @Field(() => [CodRemittance])
  nodes!: CodRemittance[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class CodRemittancesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ArgsType()
export class CodRemittanceLinesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => Int, { nullable: true, description: 'Lines after this row of the file.' })
  afterRow?: number | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'Only the lines to look into: all but those received in full, charges alone, and claims ' +
      'paid.',
  })
  issuesOnly?: boolean | null;
}

@ObjectType({ description: 'How many lines had each outcome.' })
export class CodRemittanceOutcomeCounts {
  @Field(() => Int)
  received!: number;

  @Field(() => Int)
  short!: number;

  @Field(() => Int)
  over!: number;

  @Field(() => Int)
  unmatched!: number;

  @Field(() => Int)
  repeated!: number;

  @Field(() => Int)
  notOwed!: number;

  @Field(() => Int)
  charged!: number;

  @Field(() => Int)
  compensated!: number;
}

@ObjectType({ description: 'A row of a statement that could not be read, and why.' })
export class CodRemittanceRowError {
  @Field(() => Int, { description: 'Its row in the file; the header is row 1.' })
  row!: number;

  @Field(() => String, {
    nullable: true,
    description: 'The column at fault, as the file names it.',
  })
  column!: string | null;

  @Field()
  message!: string;
}

@ObjectType()
export class CodRemittanceImportPayload {
  @Field(() => CodRemittance, {
    nullable: true,
    description: 'The statement as imported; none on a dry run, or when nothing could be read.',
  })
  remittance!: CodRemittance | null;

  @Field(() => Int, { description: 'Rows after the header.' })
  rows!: number;

  @Field(() => CodRemittanceOutcomeCounts)
  outcomes!: CodRemittanceOutcomeCounts;

  @Field(() => Money)
  collected!: Money;

  @Field(() => Money)
  charges!: Money;

  @Field(() => Money)
  tax!: Money;

  @Field(() => Money)
  paid!: Money;

  @Field(() => Money, { description: 'What of the cash was, or would be, received on orders.' })
  received!: Money;

  @Field(() => Money, {
    description: 'What of the cash paid, or would pay, claims for parcels the courier lost.',
  })
  compensated!: Money;

  @Field(() => [CodRemittanceLine], {
    description: `The first ${STATEMENT_LIMITS.lines} lines to look into, in the file's order.`,
  })
  issues!: CodRemittanceLine[];

  @Field(() => Int, { description: 'Rows that could not be read; the rest were.' })
  rowErrorCount!: number;

  @Field(() => [CodRemittanceRowError], {
    description: `The first ${STATEMENT_LIMITS.rowErrors} rows that could not be read.`,
  })
  rowErrors!: CodRemittanceRowError[];

  @Field({ description: 'Nothing was written: the counts say what would happen.' })
  dryRun!: boolean;

  @Field(() => [UserError], { description: 'Problems with the whole file; nothing was written.' })
  userErrors!: UserError[];
}
