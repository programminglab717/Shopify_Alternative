import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { ReportsService, type ReportRecord } from '@hatti/trust/public';
import { parseArgs } from 'node:util';
import { loadTrustReportsConfig } from './config.js';

// Shoppers' reports of stores (TNS-01, ADR-460), for Hatti's people: those open, the soonest due
// first, overdue marked; each dismissed, or upheld with what was done. Every report is due a
// decision within 48 hours. For Hatti's own people, by whoever runs Hatti, never through the
// Admin API.
//
//   pnpm --filter @hatti/core trust-reports list [--all]
//   pnpm --filter @hatti/core trust-reports dismiss rpt_… --by Ayesha --note "Delivered: courier proof"
//   pnpm --filter @hatti/core trust-reports uphold rpt_… --by Ayesha --note "Warned; refunded"

const USAGE =
  'Usage: trust-reports list [--all]\n' +
  '       trust-reports dismiss <report> --by <who> --note <why>\n' +
  '       trust-reports uphold <report> --by <who> --note <what was done>';

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(2);
}

type Command =
  | { command: 'list'; all: boolean }
  | { command: 'dismiss' | 'uphold'; id: string; report: string; by: string; note: string };

let parsed: Command;
try {
  parsed = parseCommand(process.argv.slice(2));
} catch (error) {
  usage((error as Error).message);
}

const config = loadTrustReportsConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'trust-reports',
});
const reports = new ReportsService(database);
try {
  if (parsed.command === 'list') {
    const found = await reports.list({ all: parsed.all });
    if (found.length === 0) console.log(parsed.all ? 'No report yet.' : 'No report is open.');
    const now = Date.now();
    for (const report of found) console.log(line(report, now));
  } else {
    const decided = await reports.decide(parsed.report, {
      status: parsed.command === 'dismiss' ? 'dismissed' : 'upheld',
      by: parsed.by,
      note: parsed.note,
    });
    if (decided === 'not_found') {
      console.error(`No report ${parsed.id}: see the list.`);
      process.exitCode = 1;
    } else if (decided === 'decided') {
      console.error(`Report ${parsed.id} was decided already.`);
      process.exitCode = 1;
    } else {
      console.log(
        `${toPublicId('storeReport', decided.id)} ${decided.status} by ${decided.decidedBy}; ` +
          `${decided.shopName} has ${decided.openOfShop} report(s) still open.`,
      );
    }
  }
} finally {
  await database.close();
}

/** A report on one line, tab-separated: overdue ones say so first. */
function line(report: ReportRecord, now: number): string {
  const overdue = report.status === 'open' && report.dueAt.getTime() < now;
  return [
    toPublicId('storeReport', report.id),
    overdue ? 'OVERDUE' : report.status,
    `due ${report.dueAt.toISOString()}`,
    `${report.shopName} (${report.shopHandle}, ${report.openOfShop} open)`,
    report.reason,
    report.phone ?? '-',
    report.orderName ?? '-',
    report.details.replace(/\s+/g, ' '),
  ].join('\t');
}

/** The command line, checked: what to do, and with which report. */
function parseCommand(args: string[]): Command {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      by: { type: 'string' },
      note: { type: 'string' },
    },
  });
  const [command, id, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected: ${rest.join(' ')}`);
  if (command === 'list') {
    if (id) throw new Error(`Unexpected: ${id}`);
    return { command, all: values.all ?? false };
  }
  if (command !== 'dismiss' && command !== 'uphold') throw new Error('Say what to do');
  if (!id) throw new Error('Name the report, as the list shows it');
  const by = values.by?.trim();
  if (!by) throw new Error("Say who among Hatti's people decided it, with --by");
  const note = values.note?.trim();
  if (!note) throw new Error('Say why, or what was done, with --note');
  return { command, id, report: tryFromPublicId(id, 'storeReport') ?? id, by, note };
}
