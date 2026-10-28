import { UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { JOURNAL_LIMITS } from '../accounting-journal.js';
import { SALES_REPORT_LIMITS } from '../sales-report.service.js';
import { OrderExportFile } from './export.types.js';

export enum JournalAccount {
  RECEIVABLE = 'RECEIVABLE',
  SALES = 'SALES',
  DISCOUNTS = 'DISCOUNTS',
  RETURNS = 'RETURNS',
  SHIPPING = 'SHIPPING',
  FEES = 'FEES',
  SALES_TAX = 'SALES_TAX',
  COST_OF_GOODS = 'COST_OF_GOODS',
  INVENTORY = 'INVENTORY',
  BANK = 'BANK',
  COURIER_CHARGES = 'COURIER_CHARGES',
  COURIERS = 'COURIERS',
  WRITE_OFFS = 'WRITE_OFFS',
  CLAIMS = 'CLAIMS',
}

registerEnumType(JournalAccount, {
  name: 'JournalAccount',
  description: "An account the shop's journal posts to (ANL-10, ADR-885).",
  valuesMap: {
    RECEIVABLE: {
      description:
        "What the day's orders came to, owed by customers and couriers; refunds paid back to it.",
    },
    SALES: { description: 'Items at the prices sold, without their tax.' },
    DISCOUNTS: { description: 'Discounts given, without their tax.' },
    RETURNS: { description: 'Items that came back, without their tax.' },
    SHIPPING: { description: 'Delivery charged, without its tax.' },
    FEES: { description: 'Fees for paying on delivery, without their tax.' },
    SALES_TAX: { description: 'The sales tax the orders include.' },
    COST_OF_GOODS: { description: 'What the items kept cost.' },
    INVENTORY: { description: 'Stock: what the items kept, and those written off, cost.' },
    BANK: { description: 'Where refunds were paid from.' },
    COURIER_CHARGES: {
      description: "Couriers' charges on their statements; on plans with true profit.",
    },
    COURIERS: {
      description:
        'What the shop and its couriers owe each other: their charges, less the claims they paid.',
    },
    WRITE_OFFS: { description: 'Stock written off; on plans with true profit.' },
    CLAIMS: { description: 'Claims couriers paid; on plans with true profit.' },
  },
});

export enum JournalFormat {
  CSV = 'CSV',
  XERO = 'XERO',
  QUICKBOOKS = 'QUICKBOOKS',
  TALLY = 'TALLY',
}

registerEnumType(JournalFormat, {
  name: 'JournalFormat',
  description: 'What the journal is written for (ADR-885).',
  valuesMap: {
    CSV: { description: "A line for each debit or credit, with its accounts' codes and names." },
    XERO: { description: "Xero's manual journal import, by account code." },
    QUICKBOOKS: { description: "QuickBooks Online's journal entry import, by account name." },
    TALLY: { description: "Tally's XML of journal vouchers, by ledger name." },
  },
});

@ObjectType({ description: "An account the journal posts to, as the shop's books know it." })
export class JournalLedger {
  @Field(() => JournalAccount)
  account!: JournalAccount;

  @Field({ description: "Its code in the shop's books: what Xero posts by." })
  code!: string;

  @Field({ description: "Its name in the shop's books: what QuickBooks and Tally post by." })
  name!: string;

  @Field({ description: "Whether the shop named it; else Hatti's usual name and code." })
  named!: boolean;
}

@InputType()
export class JournalLedgerInput {
  @Field(() => JournalAccount)
  account!: JournalAccount;

  @Field({
    description: `At most ${JOURNAL_LIMITS.code} characters; blank with the name for Hatti's usual.`,
  })
  code!: string;

  @Field({
    description: `At most ${JOURNAL_LIMITS.name} characters; blank with the code for Hatti's usual.`,
  })
  name!: string;
}

@ObjectType()
export class JournalLedgersSetPayload {
  @Field(() => [JournalLedger], {
    nullable: true,
    description: 'Every account; null where refused.',
  })
  journalLedgers!: JournalLedger[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ArgsType()
export class AccountingJournalExportArgs {
  @Field(() => GraphQLISODateTime, { description: 'Orders placed at or after this.' })
  placedFrom!: Date;

  @Field(() => GraphQLISODateTime, {
    description: `Orders placed before this; at most ${SALES_REPORT_LIMITS.days} days after placedFrom.`,
  })
  placedBefore!: Date;

  @Field(() => JournalFormat, { defaultValue: JournalFormat.CSV })
  format!: JournalFormat;
}

@ObjectType()
export class AccountingJournalExportPayload {
  @Field(() => OrderExportFile, {
    nullable: true,
    description:
      '"journal-2026-10-01-to-2026-10-31.csv", or "-xero.csv", "-quickbooks.csv", "-tally.xml": ' +
      'an entry a day. Null where refused.',
  })
  file!: OrderExportFile | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
