import { PublicSite } from '@hatti/api';
import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { MessagesService } from '@hatti/messaging/public';
import {
  AppealsService,
  REPORT_REASONS,
  ReportsService,
  TakedownsService,
  type AppealRecord,
  type ReportRecord,
  type TakedownRecord,
} from '@hatti/trust/public';
import { parseArgs } from 'node:util';
import { loadTrustReportsConfig } from './config.js';
import { refuseAppeal, restoreStore, takeDown } from './takedowns.js';

// Shoppers' reports of stores (TNS-01, ADR-460), for Hatti's people: those open, the soonest due
// first, overdue marked; each dismissed, or upheld with what was done. Every report is due a
// decision within 48 hours. For Hatti's own people, by whoever runs Hatti, never through the
// Admin API.
//
//   pnpm --filter @hatti/core trust-reports list [--all]
//   pnpm --filter @hatti/core trust-reports dismiss rpt_… --by Ayesha --note "Delivered: courier proof"
//   pnpm --filter @hatti/core trust-reports uphold rpt_… --by Ayesha --note "Warned; refunded"
//
// A store whose reports are upheld is taken down, and restored once it is put right (ADR-461),
// its owner told each time:
//
//   pnpm --filter @hatti/core trust-reports takedowns [--all]
//   pnpm --filter @hatti/core trust-reports suspend zari --reason scam --by Ayesha --note "…"
//   pnpm --filter @hatti/core trust-reports restore zari --by Ayesha --note "Refunded every advance"
//
// Its owner appeals through the link in the notice (ADR-462); restoring the store upholds the
// appeal waiting, and refusing it says why on the link's page and on WhatsApp:
//
//   pnpm --filter @hatti/core trust-reports appeals [--all]
//   pnpm --filter @hatti/core trust-reports refuse apl_… --by Ayesha --note "Tracking shows none delivered"

const USAGE =
  'Usage: trust-reports list [--all]\n' +
  '       trust-reports dismiss <report> --by <who> --note <why>\n' +
  '       trust-reports uphold <report> --by <who> --note <what was done>\n' +
  '       trust-reports takedowns [--all]\n' +
  `       trust-reports suspend <shop> --reason <${REPORT_REASONS.join('|')}> --by <who> --note <why, as the owner is told>\n` +
  '       trust-reports restore <shop> --by <who> --note <why, as the owner is told>\n' +
  '       trust-reports appeals [--all]\n' +
  '       trust-reports refuse <appeal> --by <who> --note <why, as the owner is told>';

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(2);
}

type Command =
  | { command: 'list'; all: boolean }
  | { command: 'takedowns'; all: boolean }
  | { command: 'appeals'; all: boolean }
  | { command: 'refuse'; id: string; appeal: string; by: string; note: string }
  | { command: 'dismiss' | 'uphold'; id: string; report: string; by: string; note: string }
  | { command: 'suspend'; shop: string; reason: string; by: string; note: string }
  | { command: 'restore'; shop: string; by: string; note: string };

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
const takedowns = new TakedownsService(database);
const messages = new MessagesService(database);
const appeals = new AppealsService(database);
try {
  if (parsed.command === 'takedowns') {
    const found = await takedowns.list({ all: parsed.all });
    if (found.length === 0)
      console.log(parsed.all ? 'No store taken down yet.' : 'No store is down.');
    for (const takedown of found) console.log(takedownLine(takedown));
  } else if (parsed.command === 'appeals') {
    const found = await appeals.list({ all: parsed.all });
    if (found.length === 0) console.log(parsed.all ? 'No appeal yet.' : 'No appeal is waiting.');
    for (const appeal of found) console.log(appealLine(appeal));
  } else if (parsed.command === 'refuse') {
    const refused = await refuseAppeal(database, appeals, messages, parsed.appeal, {
      by: parsed.by,
      answer: parsed.note,
    });
    if (refused === 'not_found') {
      console.error(`No appeal ${parsed.id}: see the list.`);
      process.exitCode = 1;
    } else if (refused === 'answered') {
      console.error(`Appeal ${parsed.id} was answered already.`);
      process.exitCode = 1;
    } else {
      console.log(`${refused.shopName}'s appeal is refused; its owner is told.`);
    }
  } else if (parsed.command === 'suspend' || parsed.command === 'restore') {
    if (parsed.command === 'suspend' && !config.PUBLIC_URL) {
      usage('Set PUBLIC_URL: the notice links to the page its owner appeals on there.');
    }
    const done =
      parsed.command === 'suspend'
        ? await takeDown(
            database,
            takedowns,
            messages,
            new PublicSite(config.PUBLIC_URL!),
            parsed.shop,
            parsed,
          )
        : await restoreStore(database, takedowns, messages, parsed.shop, parsed);
    if (typeof done === 'string') {
      console.error(
        {
          not_found: `No shop ${parsed.shop}: name it by its handle.`,
          not_active: `${parsed.shop} is not open: only an open store is taken down.`,
          not_suspended: `${parsed.shop} is not down.`,
        }[done],
      );
      process.exitCode = 1;
    } else {
      console.log(
        parsed.command === 'suspend'
          ? `${done.shopName} (${done.shopHandle}) is down; its owner is told.`
          : `${done.shopName} (${done.shopHandle}) is open again; its owner is told.`,
      );
    }
  } else if (parsed.command === 'list') {
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

/** An appeal on one line, tab-separated: those waiting say so first. */
function appealLine(appeal: AppealRecord): string {
  return [
    toPublicId('storeAppeal', appeal.id),
    appeal.status === 'open' ? 'WAITING' : appeal.status,
    `since ${appeal.createdAt.toISOString()}`,
    `${appeal.shopName} (${appeal.shopHandle})`,
    `down for ${appeal.reason}: ${appeal.takedownNote.replace(/\s+/g, ' ')}`,
    appeal.words.replace(/\s+/g, ' '),
    appeal.answer ? `answered by ${appeal.answeredBy}: ${appeal.answer}` : '',
  ].join('\t');
}

/** A takedown on one line, tab-separated: those of stores still down say so first. */
function takedownLine(takedown: TakedownRecord): string {
  return [
    takedown.restoredAt ? `restored ${takedown.restoredAt.toISOString()}` : 'DOWN',
    `since ${takedown.createdAt.toISOString()}`,
    `${takedown.shopName} (${takedown.shopHandle})`,
    takedown.reason,
    `by ${takedown.takenBy}`,
    takedown.note.replace(/\s+/g, ' '),
    takedown.restoreNote ? `restored by ${takedown.restoredBy}: ${takedown.restoreNote}` : '',
  ].join('\t');
}

/** The command line, checked: what to do, and with which report or shop. */
function parseCommand(args: string[]): Command {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      by: { type: 'string' },
      note: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  const [command, id, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected: ${rest.join(' ')}`);
  if (command === 'list' || command === 'takedowns' || command === 'appeals') {
    if (id) throw new Error(`Unexpected: ${id}`);
    return { command, all: values.all ?? false };
  }
  if (
    command !== 'dismiss' &&
    command !== 'uphold' &&
    command !== 'suspend' &&
    command !== 'restore' &&
    command !== 'refuse'
  ) {
    throw new Error('Say what to do');
  }
  if (!id) {
    throw new Error(
      command === 'suspend' || command === 'restore'
        ? 'Name the shop, by its handle'
        : command === 'refuse'
          ? 'Name the appeal, as the list of appeals shows it'
          : 'Name the report, as the list shows it',
    );
  }
  const by = values.by?.trim();
  if (!by) throw new Error("Say who among Hatti's people decided it, with --by");
  const note = values.note?.trim();
  if (!note) throw new Error('Say why, or what was done, with --note');
  if (command === 'restore') return { command, shop: id, by, note };
  if (command === 'refuse') {
    return { command, id, appeal: tryFromPublicId(id, 'storeAppeal') ?? id, by, note };
  }
  if (command === 'suspend') {
    const reason = values.reason?.trim() ?? '';
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
      throw new Error(`Say why it is taken down, with --reason: ${REPORT_REASONS.join(', ')}`);
    }
    return { command, shop: id, reason, by, note };
  }
  return { command, id, report: tryFromPublicId(id, 'storeReport') ?? id, by, note };
}
