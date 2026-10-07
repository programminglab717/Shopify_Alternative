import { PublicSite } from '@hatti/api';
import { BILLING_CURRENCY, BillingService, type TransferChecked } from '@hatti/billing/public';
import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { formatMoney, fromMajor, money } from '@hatti/money';
import { parseArgs } from 'node:util';
import { loadBillingTransfersConfig } from './config.js';

// The transfers shops said they made into Hatti's own bank account (ADR-254), for Hatti's people
// to find there: those waiting, the oldest first; each found confirmed, which pays its invoice,
// with what came if it was not the amount said; and each not found refused, saying why, which the
// shop's owner is told. For Hatti's own people, by whoever runs Hatti, never through the Admin API.
//
//   pnpm --filter @hatti/core billing-transfers list
//   pnpm --filter @hatti/core billing-transfers confirm btr_… --by Ayesha [--received 2,499]
//   pnpm --filter @hatti/core billing-transfers refuse btr_… --by Ayesha --reason "Not found"

const USAGE =
  'Usage: billing-transfers list\n' +
  '       billing-transfers confirm <transfer> --by <who> [--received <rupees>]\n' +
  '       billing-transfers refuse <transfer> --by <who> --reason <why>';

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(2);
}

let parsed: ReturnType<typeof parseCommand>;
try {
  parsed = parseCommand(process.argv.slice(2));
} catch (error) {
  usage((error as Error).message);
}

const config = loadBillingTransfersConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'billing-transfers',
});
const billing = new BillingService(
  database,
  new PublicSite(config.PUBLIC_URL ?? 'http://localhost:4000'),
);
try {
  if (parsed.command === 'list') {
    const waiting = await billing.waitingTransfers();
    if (waiting.length === 0) console.log('No transfer waits.');
    for (const transfer of waiting) {
      console.log(
        [
          toPublicId('billingTransfer', transfer.id),
          transfer.reportedAt.toISOString(),
          transfer.shopName,
          transfer.invoiceName,
          rupees(transfer.amount),
          transfer.reference,
        ].join('\t'),
      );
    }
  } else {
    const checked =
      parsed.command === 'confirm'
        ? await billing.confirmTransfer(parsed.transfer, {
            by: parsed.by,
            received: parsed.received,
          })
        : await billing.refuseTransfer(parsed.transfer, { by: parsed.by, reason: parsed.reason });
    if (checked === 'not_found') {
      console.error(`No transfer ${parsed.id} was said: see the list.`);
      process.exitCode = 1;
    } else if (checked === 'checked') {
      console.error(`Transfer ${parsed.id} was confirmed or refused already.`);
      process.exitCode = 1;
    } else {
      console.log(said(checked));
    }
  }
} finally {
  await database.close();
}

/** The command line, checked: what to do, and with which transfer. */
function parseCommand(
  args: string[],
):
  | { command: 'list' }
  | { command: 'confirm'; id: string; transfer: string; by: string; received: bigint | null }
  | { command: 'refuse'; id: string; transfer: string; by: string; reason: string } {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      by: { type: 'string' },
      received: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  const [command, id, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected: ${rest.join(' ')}`);
  if (command === 'list') {
    if (id) throw new Error(`Unexpected: ${id}`);
    return { command };
  }
  if (command !== 'confirm' && command !== 'refuse') throw new Error('Say what to do');
  if (!id) throw new Error('Name the transfer, as the list shows it');
  // As the list shows it, or as the database keeps it.
  const transfer = tryFromPublicId(id, 'billingTransfer') ?? id;
  const by = values.by?.trim();
  if (!by) throw new Error("Say who among Hatti's people checked it, with --by");
  if (command === 'refuse') {
    const reason = values.reason?.trim();
    if (!reason) throw new Error("Say why, with --reason: the shop's owner is told");
    if (values.received !== undefined) throw new Error('A transfer refused received nothing');
    return { command, id, transfer, by, reason };
  }
  if (values.reason !== undefined) throw new Error('A transfer confirmed needs no reason');
  let received: bigint | null = null;
  if (values.received !== undefined) {
    received = fromMajor(values.received, BILLING_CURRENCY).amount;
    if (received <= 0n) throw new Error('--received is what came: more than nothing');
  }
  return { command, id, transfer, by, received };
}

/** What became of a transfer checked, and of its invoice. */
function said(checked: TransferChecked): string {
  const invoice = checked.invoiceName;
  switch (checked.outcome) {
    case 'paid':
      return `Confirmed: invoice ${invoice} is paid, and the shop's owner is told.`;
    case 'short':
      return `Confirmed: invoice ${invoice} waits for ${rupees(checked.left)} more.`;
    case 'already_paid':
      return (
        `Confirmed, but invoice ${invoice} was paid otherwise already: what came is Hatti's ` +
        'to give back.'
      );
    case 'refused':
      return "Refused: the shop's owner is told why, and may say another transfer.";
  }
}

function rupees(amount: bigint): string {
  return formatMoney(money(amount, BILLING_CURRENCY));
}
