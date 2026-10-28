import { toCsv } from '@hatti/csv';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import type { SalesPeriod } from './sales-report.service.js';

// A shop's sales as its books take them (ANL-10, ADR-885): a journal of debits and credits, an
// entry for each day of the sales report (ADR-798) in the shop's time zone, posting what the day's
// orders came to, against the accounts the shop names, for its accountant to import into Xero,
// QuickBooks or Tally, or read as it is. What the shop is paid is not posted: the accountant
// clears the receivable from the bank's statement and couriers' remittances, as they come.

/** The accounts the journal posts to, each a shop may name and number as its books do. */
export const JOURNAL_ACCOUNTS = [
  'receivable',
  'sales',
  'discounts',
  'returns',
  'shipping',
  'fees',
  'sales_tax',
  'cost_of_goods',
  'inventory',
  'bank',
  'courier_charges',
  'couriers',
  'write_offs',
  'claims',
] as const;
export type JournalAccount = (typeof JOURNAL_ACCOUNTS)[number];

/** An account as the shop's books know it: its code (Xero's) and its name (QuickBooks', Tally's). */
export interface JournalLedger {
  code: string;
  name: string;
}

/** What each account is called where a shop has not named it: a small shop's usual chart. */
export const DEFAULT_LEDGERS: Readonly<Record<JournalAccount, JournalLedger>> = {
  receivable: { code: '1200', name: 'Sales receivable' },
  sales: { code: '4000', name: 'Sales' },
  discounts: { code: '4010', name: 'Sales discounts' },
  returns: { code: '4020', name: 'Sales returns' },
  shipping: { code: '4100', name: 'Delivery charges' },
  fees: { code: '4110', name: 'Cash on delivery fees' },
  sales_tax: { code: '2200', name: 'Sales tax payable' },
  cost_of_goods: { code: '5000', name: 'Cost of goods sold' },
  inventory: { code: '1300', name: 'Inventory' },
  bank: { code: '1000', name: 'Cash and bank' },
  courier_charges: { code: '5100', name: 'Courier charges' },
  couriers: { code: '2100', name: 'Courier account' },
  write_offs: { code: '5200', name: 'Stock written off' },
  claims: { code: '4200', name: 'Courier claims recovered' },
};

export const JOURNAL_LIMITS = {
  /** An account's code. */
  code: 20,
  /** An account's name, as Tally allows a ledger's. */
  name: 100,
} as const;

export const JOURNAL_FORMATS = ['csv', 'xero', 'quickbooks', 'tally'] as const;
export type JournalFormat = (typeof JOURNAL_FORMATS)[number];

/** A line of an entry: one side or the other, in minor units of the shop's currency. */
export interface JournalLine {
  account: JournalAccount;
  debit: bigint;
  credit: bigint;
  /** What it is: "Orders' items at the prices sold". */
  description: string;
}

export interface JournalEntry {
  /** "2026-10-05", in the shop's time zone. */
  day: string;
  /** "HATTI-20261005": the same day's entry is the same number, however often it is exported. */
  number: string;
  narration: string;
  lines: JournalLine[];
}

/** The day a period starts on, "2026-10-05", in the shop's time zone. */
function dayOf(start: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(start);
}

/**
 * The journal of the report's days: for each with anything to post, an entry whose debits and
 * credits are equal.
 *
 * * **The sales:** the receivable is debited with total sales, discounts and returns with what
 *   they took off; sales are credited with the items at the prices sold, and delivery charges,
 *   fees and sales tax with theirs, each without the tax but tax's own (ADR-117).
 * * **The goods:** cost of goods sold is debited with what the items kept cost, inventory
 *   credited.
 * * **Refunds** paid are debited to the receivable, as they were paid from the bank.
 * * **True profit's lines**, where the plan has them (ADR-529): couriers' charges their statements
 *   made, not those only estimated; stock written off; and claims couriers paid.
 */
export function journalOf(
  periods: readonly SalesPeriod[],
  timezone: string,
  trueProfit: boolean,
): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const period of periods) {
    const lines: JournalLine[] = [];
    const post = (
      account: JournalAccount,
      side: 'debit' | 'credit',
      amount: bigint,
      description: string,
    ) => {
      if (amount === 0n) return;
      // A negative amount is the other side's.
      const flipped = amount < 0n;
      const onDebit = (side === 'debit') !== flipped;
      const value = flipped ? -amount : amount;
      lines.push({
        account,
        debit: onDebit ? value : 0n,
        credit: onDebit ? 0n : value,
        description,
      });
    };
    const total =
      period.grossSales -
      period.discounts -
      period.returns +
      period.shipping +
      period.additionalFees +
      period.taxes;
    post('receivable', 'debit', total, "What the day's orders came to");
    post('discounts', 'debit', period.discounts, 'Discounts, without their tax');
    post('returns', 'debit', period.returns, 'Items that came back, without their tax');
    post('sales', 'credit', period.grossSales, 'Items at the prices sold, without their tax');
    post('shipping', 'credit', period.shipping, 'Delivery charged, without its tax');
    post('fees', 'credit', period.additionalFees, 'Fees for paying on delivery, without their tax');
    post('sales_tax', 'credit', period.taxes, 'Sales tax the orders include');
    post('cost_of_goods', 'debit', period.costOfGoods, 'What the items kept cost');
    post('inventory', 'credit', period.costOfGoods, 'Items kept, out of stock');
    post('receivable', 'debit', period.refunds, 'Refunds paid');
    post('bank', 'credit', period.refunds, 'Refunds paid');
    if (trueProfit) {
      const charged = period.shippingCosts - period.shippingCostsEstimated;
      post('courier_charges', 'debit', charged, "Couriers' charges on their statements");
      post('couriers', 'credit', charged, "Couriers' charges on their statements");
      post('write_offs', 'debit', period.writeOffs, 'Stock written off');
      post('inventory', 'credit', period.writeOffs, 'Stock written off');
      post('couriers', 'debit', period.claimsRecovered, 'Claims couriers paid');
      post('claims', 'credit', period.claimsRecovered, 'Claims couriers paid');
    }
    if (lines.length === 0) continue;
    const debits = lines.reduce((sum, line) => sum + line.debit, 0n);
    const credits = lines.reduce((sum, line) => sum + line.credit, 0n);
    if (debits !== credits)
      throw new Error(`The journal of ${period.start.toISOString()} does not balance`);
    const day = dayOf(period.start, timezone);
    entries.push({
      day,
      number: `HATTI-${day.replaceAll('-', '')}`,
      narration: `Sales of ${day}, from Hatti`,
      lines,
    });
  }
  return entries;
}

/** What a journal is written with: the shop's accounts, and its currency. */
export interface JournalWriting {
  ledgers: Readonly<Record<JournalAccount, JournalLedger>>;
  currency: string;
}

/** A file of the journal, to save. */
export interface JournalFile {
  /** "journal-2026-10-01-to-2026-10-31.csv", by its first and last day. */
  filename: string;
  contentType: string;
  content: Buffer;
}

const CSV_TYPE = 'text/csv; charset=utf-8';

/** "05/10/2026", as Xero and QuickBooks outside the United States read a day. */
function dayMonthYear(day: string): string {
  const [year, month, date] = day.split('-');
  return `${date}/${month}/${year}`;
}

function xmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The journal as a file for the shop's books:
 *
 * * `csv`: a line for each debit or credit, with its date, entry, account's code and name.
 * * `xero`: Xero's manual journal import, an amount positive for a debit, negative for a credit,
 *   by account code, its tax rate "Tax Exempt" since the sales tax has an account of its own.
 * * `quickbooks`: QuickBooks Online's journal entry import, by account name.
 * * `tally`: Tally's XML of journal vouchers, by ledger name; a debit's amount negative and
 *   deemed positive, as Tally writes them.
 */
export function journalFile(
  entries: readonly JournalEntry[],
  format: JournalFormat,
  writing: JournalWriting,
  span: { first: string; last: string },
): JournalFile {
  const amount = (minor: bigint) => toMajorString(money(minor, writing.currency as CurrencyCode));
  // Numbers, not text, so no spreadsheet reads a credit's minus sign as a formula.
  const number = (minor: bigint) => Number(amount(minor));
  const ledger = (account: JournalAccount) => writing.ledgers[account];
  const filename = `journal-${span.first}-to-${span.last}`;
  const lines = entries.flatMap((entry) => entry.lines.map((line) => ({ entry, line })));
  switch (format) {
    case 'csv':
      return {
        filename: `${filename}.csv`,
        contentType: CSV_TYPE,
        content: Buffer.from(
          toCsv([
            ['Date', 'Entry', 'Account code', 'Account', 'Description', 'Debit', 'Credit'],
            ...lines.map(({ entry, line }) => [
              entry.day,
              entry.number,
              ledger(line.account).code,
              ledger(line.account).name,
              line.description,
              line.debit ? number(line.debit) : null,
              line.credit ? number(line.credit) : null,
            ]),
          ]),
        ),
      };
    case 'xero':
      return {
        filename: `${filename}-xero.csv`,
        contentType: CSV_TYPE,
        content: Buffer.from(
          toCsv(
            [
              ['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount'],
              ...lines.map(({ entry, line }) => [
                entry.narration,
                dayMonthYear(entry.day),
                line.description,
                ledger(line.account).code,
                'Tax Exempt',
                number(line.debit - line.credit),
              ]),
            ],
            { bom: false },
          ),
        ),
      };
    case 'quickbooks':
      return {
        filename: `${filename}-quickbooks.csv`,
        contentType: CSV_TYPE,
        content: Buffer.from(
          toCsv(
            [
              ['JournalNo', 'JournalDate', 'AccountName', 'Debits', 'Credits', 'Description'],
              ...lines.map(({ entry, line }) => [
                entry.number,
                dayMonthYear(entry.day),
                ledger(line.account).name,
                line.debit ? number(line.debit) : null,
                line.credit ? number(line.credit) : null,
                line.description,
              ]),
            ],
            { bom: false },
          ),
        ),
      };
    case 'tally': {
      const vouchers = entries.map((entry) => {
        const ledgerLines = entry.lines.map((line) => {
          const debit = line.debit > 0n;
          return [
            '      <ALLLEDGERENTRIES.LIST>',
            `       <LEDGERNAME>${xmlText(ledger(line.account).name)}</LEDGERNAME>`,
            `       <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
            `       <AMOUNT>${debit ? `-${amount(line.debit)}` : amount(line.credit)}</AMOUNT>`,
            '      </ALLLEDGERENTRIES.LIST>',
          ].join('\n');
        });
        return [
          '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
          '     <VOUCHER VCHTYPE="Journal" ACTION="Create">',
          `      <DATE>${entry.day.replaceAll('-', '')}</DATE>`,
          '      <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>',
          `      <VOUCHERNUMBER>${xmlText(entry.number)}</VOUCHERNUMBER>`,
          `      <NARRATION>${xmlText(entry.narration)}</NARRATION>`,
          ...ledgerLines,
          '     </VOUCHER>',
          '    </TALLYMESSAGE>',
        ].join('\n');
      });
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ENVELOPE>',
        ' <HEADER>',
        '  <TALLYREQUEST>Import Data</TALLYREQUEST>',
        ' </HEADER>',
        ' <BODY>',
        '  <IMPORTDATA>',
        '   <REQUESTDESC>',
        '    <REPORTNAME>Vouchers</REPORTNAME>',
        '   </REQUESTDESC>',
        '   <REQUESTDATA>',
        ...vouchers,
        '   </REQUESTDATA>',
        '  </IMPORTDATA>',
        ' </BODY>',
        '</ENVELOPE>',
        '',
      ].join('\n');
      return {
        filename: `${filename}-tally.xml`,
        contentType: 'application/xml; charset=utf-8',
        content: Buffer.from(xml),
      };
    }
  }
}

/** The shop's accounts: those it named, the rest as {@link DEFAULT_LEDGERS} has them. */
export function ledgersOf(
  named: readonly ({ account: string } & JournalLedger)[],
): Record<JournalAccount, JournalLedger> {
  const ledgers = { ...DEFAULT_LEDGERS };
  for (const each of named) {
    if ((JOURNAL_ACCOUNTS as readonly string[]).includes(each.account)) {
      ledgers[each.account as JournalAccount] = { code: each.code, name: each.name };
    }
  }
  return ledgers;
}
