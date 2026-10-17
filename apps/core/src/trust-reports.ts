import { PublicSite } from '@hatti/api';
import { ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { MessagesService, SmsSendersService, type SmsSenderReview } from '@hatti/messaging/public';
import {
  AppealsService,
  REPORT_REASONS,
  ReportsService,
  RightsComplaintsService,
  TakedownsService,
  VerificationsService,
  type AppealRecord,
  type ReportRecord,
  type RightsComplaintRecord,
  type TakedownRecord,
  type VerificationLevel,
  type VerificationReview,
} from '@hatti/trust/public';
import { parseArgs } from 'node:util';
import { loadTrustReportsConfig } from './config.js';
import { refuseRightsCounter, releaseRights, upholdRights } from './rights.js';
import { approveSmsSender, refuseSmsSender, revokeSmsSender } from './sms-senders.js';
import { createStorage } from './storage.js';
import { refuseAppeal, restoreStore, takeDown } from './takedowns.js';
import { approveVerification, refuseVerification, revokeVerification } from './verifications.js';

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
//
// Shops' owners ask Hatti to verify them (ONB-11, ADR-465): their CNIC, then their business's
// NTN, each with photos of the documents, which the list links for an hour. Approving or refusing
// deletes the photos; the shop is told either way, and when a verification is taken back:
//
//   pnpm --filter @hatti/core trust-reports verifications [--all]
//   pnpm --filter @hatti/core trust-reports verify vrf_… --by Ayesha [--note "…"]
//   pnpm --filter @hatti/core trust-reports refuse-verification vrf_… --by Ayesha --note "The photo is blurred"
//   pnpm --filter @hatti/core trust-reports unverify zari --level identity --by Ayesha --note "…"
//
// Shops ask for their customers' SMS to come from a name of their own (MKT-02, ADR-469), which
// operators register for a verified shop; once they have, it is approved, or refused with why,
// and may be taken back. The shop is told each time:
//
//   pnpm --filter @hatti/core trust-reports senders [--all]
//   pnpm --filter @hatti/core trust-reports approve-sender snd_… --by Ayesha [--note "…"]
//   pnpm --filter @hatti/core trust-reports refuse-sender snd_… --by Ayesha --note "Jazz refused it"
//   pnpm --filter @hatti/core trust-reports revoke-sender zari --by Ayesha --note "…"
//
// A product whose words name goods Hatti does not allow selling stays a draft (TNS-03, ADR-473);
// one found by mistake is cleared for its words as they are, and may then go on sale:
//
//   pnpm --filter @hatti/core trust-reports clear-listing prod_… --by Ayesha
//
// Owners of a trademark or copyright, or someone acting for them, complain of a store's listings
// from its rights page (TNS-04, ADR-474), each due a decision within 48 hours. The list gives
// whose right, who complains and their email, and the listings; one found wanting is dismissed,
// and the complainant written to. One upheld takes its listings off sale, held there, and tells
// the store's owner who complained and how to reach them (ADR-475):
//
//   pnpm --filter @hatti/core trust-reports rights [--all]
//   pnpm --filter @hatti/core trust-reports dismiss-rights ipc_… --by Ayesha --note "Its own label"
//   pnpm --filter @hatti/core trust-reports uphold-rights ipc_… --by Ayesha --note "Sold as Gul Ahmed's"
//
// The notice links to a page where the owner answers the complaint once, sworn (ADR-476); the
// answer is refused with why, or the listings let go, which upholds it; the owner told each time:
//
//   pnpm --filter @hatti/core trust-reports counters [--all]
//   pnpm --filter @hatti/core trust-reports refuse-counter ipc_… --by Ayesha --note "…"
//   pnpm --filter @hatti/core trust-reports release-rights ipc_… --by Ayesha --note "Withdrawn"

const USAGE =
  'Usage: trust-reports list [--all]\n' +
  '       trust-reports dismiss <report> --by <who> --note <why>\n' +
  '       trust-reports uphold <report> --by <who> --note <what was done>\n' +
  '       trust-reports takedowns [--all]\n' +
  `       trust-reports suspend <shop> --reason <${REPORT_REASONS.join('|')}> --by <who> --note <why, as the owner is told>\n` +
  '       trust-reports restore <shop> --by <who> --note <why, as the owner is told>\n' +
  '       trust-reports appeals [--all]\n' +
  '       trust-reports refuse <appeal> --by <who> --note <why, as the owner is told>\n' +
  '       trust-reports verifications [--all]\n' +
  '       trust-reports verify <verification> --by <who> [--note <note>]\n' +
  '       trust-reports refuse-verification <verification> --by <who> --note <why, as the owner is told>\n' +
  '       trust-reports unverify <shop> --level <identity|business> --by <who> --note <why, as the owner is told>\n' +
  '       trust-reports senders [--all]\n' +
  '       trust-reports approve-sender <request> --by <who> [--note <note>]\n' +
  '       trust-reports refuse-sender <request> --by <who> --note <why, as the shop is told>\n' +
  '       trust-reports revoke-sender <shop> --by <who> --note <why, as the shop is told>\n' +
  '       trust-reports clear-listing <product> --by <who>\n' +
  '       trust-reports rights [--all]\n' +
  '       trust-reports dismiss-rights <complaint> --by <who> --note <why>\n' +
  '       trust-reports uphold-rights <complaint> --by <who> --note <why, as the owner is told>\n' +
  '       trust-reports counters [--all]\n' +
  '       trust-reports refuse-counter <complaint> --by <who> --note <why, as the owner is told>\n' +
  '       trust-reports release-rights <complaint> --by <who> --note <why, as the owner is told>';

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(2);
}

type Command =
  | { command: 'list'; all: boolean }
  | { command: 'takedowns'; all: boolean }
  | { command: 'appeals'; all: boolean }
  | { command: 'verifications'; all: boolean }
  | { command: 'senders'; all: boolean }
  | { command: 'rights'; all: boolean }
  | { command: 'dismiss-rights'; id: string; complaint: string; by: string; note: string }
  | { command: 'uphold-rights'; id: string; complaint: string; by: string; note: string }
  | { command: 'counters'; all: boolean }
  | { command: 'refuse-counter'; id: string; complaint: string; by: string; note: string }
  | { command: 'release-rights'; id: string; complaint: string; by: string; note: string }
  | { command: 'approve-sender'; id: string; request: string; by: string; note: string }
  | { command: 'refuse-sender'; id: string; request: string; by: string; note: string }
  | { command: 'revoke-sender'; shop: string; by: string; note: string }
  | { command: 'clear-listing'; id: string; product: string; by: string }
  | { command: 'verify'; id: string; verification: string; by: string; note: string }
  | { command: 'refuse-verification'; id: string; verification: string; by: string; note: string }
  | { command: 'unverify'; shop: string; level: VerificationLevel; by: string; note: string }
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
const verifications = new VerificationsService(
  database,
  createStorage(config, config.PUBLIC_URL ?? 'http://localhost:3000'),
);
const senders = new SmsSendersService(database);
const rights = new RightsComplaintsService(database);
try {
  if (parsed.command === 'rights') {
    const found = await rights.list({ all: parsed.all });
    if (found.length === 0) {
      console.log(parsed.all ? 'No rights complaint yet.' : 'No rights complaint is open.');
    }
    const now = Date.now();
    for (const complaint of found) console.log(rightsLines(complaint, now));
  } else if (parsed.command === 'counters') {
    const found = await rights.counters({ all: parsed.all });
    if (found.length === 0) {
      console.log(parsed.all ? 'No answer to a rights complaint yet.' : 'No answer is waiting.');
    }
    for (const complaint of found) console.log(counterLine(complaint));
  } else if (parsed.command === 'refuse-counter' || parsed.command === 'release-rights') {
    const done =
      parsed.command === 'refuse-counter'
        ? await refuseRightsCounter(database, rights, messages, parsed.complaint, {
            by: parsed.by,
            answer: parsed.note,
          })
        : await releaseRights(
            database,
            rights,
            new ProductService(database),
            messages,
            parsed.complaint,
            { by: parsed.by, note: parsed.note },
          );
    if (done === 'not_found') {
      console.error(`No rights complaint ${parsed.id}: see the list.`);
      process.exitCode = 1;
    } else if (done === 'not_upheld') {
      console.error(`Rights complaint ${parsed.id} was not upheld: nothing is held for it.`);
      process.exitCode = 1;
    } else if (done === 'answered') {
      console.error(
        parsed.command === 'refuse-counter'
          ? `No answer to ${parsed.id} is waiting.`
          : `The listings of ${parsed.id} were let go already.`,
      );
      process.exitCode = 1;
    } else if ('released' in done) {
      console.log(
        `${done.released} listing(s) of ${done.complaint.shopName} let go; its owner is told, ` +
          `and ${done.complaint.complainant} may be written to at ${done.complaint.email}.`,
      );
    } else {
      console.log(`${done.shopName}'s answer is refused; its owner is told.`);
    }
  } else if (parsed.command === 'uphold-rights') {
    if (!config.PUBLIC_URL) {
      usage('Set PUBLIC_URL: the notice links to the page its owner answers on there.');
    }
    const upheld = await upholdRights(
      database,
      rights,
      new ProductService(database),
      messages,
      new PublicSite(config.PUBLIC_URL),
      parsed.complaint,
      { by: parsed.by, note: parsed.note },
    );
    if (upheld === 'not_found') {
      console.error(`No rights complaint ${parsed.id}: see the list.`);
      process.exitCode = 1;
    } else if (upheld === 'decided') {
      console.error(`Rights complaint ${parsed.id} was decided already.`);
      process.exitCode = 1;
    } else {
      const { complaint, held } = upheld;
      console.log(
        `${toPublicId('rightsComplaint', complaint.id)} upheld by ${complaint.decidedBy}; ` +
          (held.length > 0
            ? `${held.length} listing(s) of ${complaint.shopName} taken off sale, its owner told`
            : `none of its listings is ${complaint.shopName}'s any longer`) +
          `; write to ${complaint.complainant} at ${complaint.email}.`,
      );
    }
  } else if (parsed.command === 'dismiss-rights') {
    const decided = await rights.decide(parsed.complaint, {
      status: 'dismissed',
      by: parsed.by,
      note: parsed.note,
    });
    if (decided === 'not_found') {
      console.error(`No rights complaint ${parsed.id}: see the list.`);
      process.exitCode = 1;
    } else if (decided === 'decided') {
      console.error(`Rights complaint ${parsed.id} was decided already.`);
      process.exitCode = 1;
    } else {
      console.log(
        `${toPublicId('rightsComplaint', decided.id)} dismissed by ${decided.decidedBy}; ` +
          `write to ${decided.complainant} at ${decided.email} with why.`,
      );
    }
  } else if (parsed.command === 'clear-listing') {
    const cleared = await new ProductService(database).clearScreening(parsed.product);
    if (!cleared) {
      console.error(`No product ${parsed.id}: name it by its ID, as the shop's admin shows it.`);
      process.exitCode = 1;
    } else {
      console.log(
        `${cleared.title} cleared by ${parsed.by}` +
          (cleared.found.length > 0 ? ` (it named ${cleared.found.join(', ')})` : '') +
          '; it may go on sale until its words change.',
      );
    }
  } else if (parsed.command === 'senders') {
    const found = await senders.list({ all: parsed.all });
    if (found.length === 0) {
      console.log(parsed.all ? 'No sender name asked for yet.' : 'No sender name is waiting.');
    }
    for (const request of found) console.log(senderLine(request));
  } else if (
    parsed.command === 'approve-sender' ||
    parsed.command === 'refuse-sender' ||
    parsed.command === 'revoke-sender'
  ) {
    const done =
      parsed.command === 'approve-sender'
        ? await approveSmsSender(database, senders, messages, parsed.request, {
            by: parsed.by,
            note: parsed.note,
          })
        : parsed.command === 'refuse-sender'
          ? await refuseSmsSender(database, senders, messages, parsed.request, {
              by: parsed.by,
              answer: parsed.note,
            })
          : await revokeSmsSender(database, senders, messages, parsed.shop, {
              by: parsed.by,
              answer: parsed.note,
            });
    if (typeof done === 'string') {
      console.error(
        {
          not_found:
            parsed.command === 'revoke-sender'
              ? `No shop ${parsed.shop}: name it by its handle.`
              : 'No such request: see the list of senders.',
          decided: 'It was decided already.',
          taken: 'Another shop sends from that name.',
          not_verified: "Hatti hasn't verified the shop: its sender waits for that.",
          not_approved: `${parsed.command === 'revoke-sender' ? parsed.shop : 'It'} has no name of its own.`,
        }[done],
      );
      process.exitCode = 1;
    } else {
      console.log(
        `${done.shopName} (${done.shopHandle}): ${done.name} ${done.status}; the shop is told.`,
      );
    }
  } else if (parsed.command === 'verifications') {
    const found = await verifications.list({ all: parsed.all });
    if (found.length === 0) {
      console.log(parsed.all ? 'No verification asked for yet.' : 'No verification is waiting.');
    }
    for (const review of found) console.log(verificationLine(review));
  } else if (
    parsed.command === 'verify' ||
    parsed.command === 'refuse-verification' ||
    parsed.command === 'unverify'
  ) {
    const done =
      parsed.command === 'verify'
        ? await approveVerification(database, verifications, messages, parsed.verification, {
            by: parsed.by,
            note: parsed.note,
          })
        : parsed.command === 'refuse-verification'
          ? await refuseVerification(database, verifications, messages, parsed.verification, {
              by: parsed.by,
              answer: parsed.note,
            })
          : await revokeVerification(database, verifications, messages, parsed.shop, parsed.level, {
              by: parsed.by,
              answer: parsed.note,
            });
    if (typeof done === 'string') {
      console.error(
        {
          not_found:
            parsed.command === 'unverify'
              ? `No shop ${parsed.shop}: name it by its handle.`
              : 'No such verification: see the list.',
          decided: 'It was decided already.',
          needs_identity: "Its owner isn't verified: verify the owner first.",
          not_verified: `${parsed.command === 'unverify' ? parsed.shop : 'It'} is not verified at that level.`,
        }[done],
      );
      process.exitCode = 1;
    } else {
      const [first] = Array.isArray(done) ? done : [done];
      console.log(
        `${first!.shopName} (${first!.shopHandle}): ${
          Array.isArray(done)
            ? `${done.map((each) => each.level).join(' and ')} taken back`
            : `${done.level} ${done.status}`
        }; its documents are deleted and the shop is told.`,
      );
    }
  } else if (parsed.command === 'takedowns') {
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

/**
 * A rights complaint on one line, tab-separated, overdue ones saying so first, then each listing
 * it names on a line of its own.
 */
function rightsLines(complaint: RightsComplaintRecord, now: number): string {
  const overdue = complaint.status === 'open' && complaint.dueAt.getTime() < now;
  return [
    [
      toPublicId('rightsComplaint', complaint.id),
      overdue ? 'OVERDUE' : complaint.status,
      `due ${complaint.dueAt.toISOString()}`,
      `${complaint.shopName} (${complaint.shopHandle})`,
      complaint.kind,
      complaint.rightsOwner + (complaint.registration ? ` [${complaint.registration}]` : ''),
      `${complaint.complainant} (${complaint.actingAs}) <${complaint.email}>`,
      complaint.phone ?? '-',
      `signed ${complaint.signature}`,
      complaint.details.replace(/\s+/g, ' '),
    ].join('\t'),
    ...complaint.listings.map(
      (listing) => `\t${toPublicId('product', listing.id)}\t${listing.title}\t${listing.url}`,
    ),
  ].join('\n');
}

/** A store owner's answer to a rights complaint on one line, tab-separated. */
function counterLine(complaint: RightsComplaintRecord): string {
  return [
    toPublicId('rightsComplaint', complaint.id),
    complaint.counterStatus ?? '-',
    `answered ${complaint.counteredAt?.toISOString() ?? '-'}`,
    `${complaint.shopName} (${complaint.shopHandle})`,
    `${complaint.rightsOwner}: ${complaint.complainant} <${complaint.email}>`,
    `signed ${complaint.counterSignature ?? '-'}`,
    (complaint.counterWords ?? '').replace(/\s+/g, ' '),
  ].join('\t');
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

/** A verification on one line, tab-separated, with links to its documents while it waits. */
function verificationLine(review: VerificationReview): string {
  return [
    toPublicId('verification', review.id),
    review.status === 'waiting' ? 'WAITING' : review.status,
    `since ${review.createdAt.toISOString()}`,
    `${review.shopName} (${review.shopHandle})`,
    review.level,
    review.name,
    review.level === 'identity'
      ? `CNIC ${review.cnic ?? `…${review.cnicLast4}`}`
      : `NTN ${review.ntn}`,
    ...verifications.documentLinks(review),
    review.answer ? `${review.status} by ${review.decidedBy}: ${review.answer}` : '',
  ].join('\t');
}

/** A sender name asked for, on one line, tab-separated: those waiting say so first. */
function senderLine(request: SmsSenderReview): string {
  return [
    toPublicId('smsSender', request.id),
    request.status === 'waiting' ? 'WAITING' : request.status,
    `since ${request.createdAt.toISOString()}`,
    `${request.shopName} (${request.shopHandle})`,
    request.name,
    request.decidedBy ? `${request.status} by ${request.decidedBy}: ${request.answer ?? ''}` : '',
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
      level: { type: 'string' },
    },
  });
  const [command, id, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected: ${rest.join(' ')}`);
  if (
    command === 'list' ||
    command === 'takedowns' ||
    command === 'appeals' ||
    command === 'verifications' ||
    command === 'senders' ||
    command === 'rights' ||
    command === 'counters'
  ) {
    if (id) throw new Error(`Unexpected: ${id}`);
    return { command, all: values.all ?? false };
  }
  if (
    command !== 'dismiss' &&
    command !== 'uphold' &&
    command !== 'suspend' &&
    command !== 'restore' &&
    command !== 'refuse' &&
    command !== 'verify' &&
    command !== 'refuse-verification' &&
    command !== 'unverify' &&
    command !== 'approve-sender' &&
    command !== 'refuse-sender' &&
    command !== 'revoke-sender' &&
    command !== 'clear-listing' &&
    command !== 'dismiss-rights' &&
    command !== 'uphold-rights' &&
    command !== 'refuse-counter' &&
    command !== 'release-rights'
  ) {
    throw new Error('Say what to do');
  }
  if (!id) {
    throw new Error(
      command === 'suspend' ||
        command === 'restore' ||
        command === 'unverify' ||
        command === 'revoke-sender'
        ? 'Name the shop, by its handle'
        : command === 'clear-listing'
          ? "Name the product, by its ID as the shop's admin shows it"
          : command === 'dismiss-rights' ||
              command === 'uphold-rights' ||
              command === 'refuse-counter' ||
              command === 'release-rights'
            ? 'Name the complaint, as the list of rights complaints shows it'
            : command === 'approve-sender' || command === 'refuse-sender'
              ? 'Name the request, as the list of senders shows it'
              : command === 'verify' || command === 'refuse-verification'
                ? 'Name the verification, as the list of verifications shows it'
                : command === 'refuse'
                  ? 'Name the appeal, as the list of appeals shows it'
                  : 'Name the report, as the list shows it',
    );
  }
  const by = values.by?.trim();
  if (!by) throw new Error("Say who among Hatti's people decided it, with --by");
  if (command === 'clear-listing') {
    return { command, id, product: tryFromPublicId(id, 'product') ?? id, by };
  }
  if (command === 'verify') {
    const verification = tryFromPublicId(id, 'verification') ?? id;
    return { command, id, verification, by, note: values.note?.trim() ?? '' };
  }
  if (command === 'approve-sender') {
    const request = tryFromPublicId(id, 'smsSender') ?? id;
    return { command, id, request, by, note: values.note?.trim() ?? '' };
  }
  const note = values.note?.trim();
  if (!note) throw new Error('Say why, or what was done, with --note');
  if (command === 'restore' || command === 'revoke-sender') return { command, shop: id, by, note };
  if (command === 'refuse-sender') {
    return { command, id, request: tryFromPublicId(id, 'smsSender') ?? id, by, note };
  }
  if (command === 'refuse-verification') {
    return { command, id, verification: tryFromPublicId(id, 'verification') ?? id, by, note };
  }
  if (command === 'unverify') {
    const level = values.level?.trim();
    if (level !== 'identity' && level !== 'business') {
      throw new Error('Say what to take back, with --level: identity or business');
    }
    return { command, shop: id, level, by, note };
  }
  if (
    command === 'dismiss-rights' ||
    command === 'uphold-rights' ||
    command === 'refuse-counter' ||
    command === 'release-rights'
  ) {
    return { command, id, complaint: tryFromPublicId(id, 'rightsComplaint') ?? id, by, note };
  }
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
