import { SUPPORT_LIMITS, SupportService, type OpenSupportRequest } from '@hatti/billing/public';
import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { parseArgs } from 'node:util';
import { loadSupportRequestsConfig } from './config.js';

// The requests shops sent Hatti's people from their admin (ADR-508): those waiting, the most
// urgent then the oldest first, as the shops' plans set, each with when it is due (ADR-525); and
// each answered, in the language the
// shop asked in, which its admin shows. For Hatti's own people, by whoever runs Hatti, never
// through the Admin API.
//
//   pnpm --filter @hatti/core support-requests list
//   pnpm --filter @hatti/core support-requests answer sreq_… --by Ayesha --text "PostEx fixed it"

const USAGE =
  'Usage: support-requests list\n' +
  '       support-requests answer <request> --by <who> --text <answer>';

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

const config = loadSupportRequestsConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'support-requests',
});
const support = new SupportService(database);
try {
  if (parsed.command === 'list') {
    const waiting = await support.waiting();
    if (waiting.length === 0) console.log('No request waits.');
    for (const request of waiting) console.log(line(request));
  } else {
    const answered = await support.answer(parsed.request, parsed.text, parsed.by);
    if (answered.ok) {
      console.log(`Answered: ${answered.value.shopName} sees it in its admin.`);
    } else {
      console.error(`No request ${parsed.id} waits for an answer: see the list.`);
      process.exitCode = 1;
    }
  }
} finally {
  await database.close();
}

/** The command line, checked: what to do, and with which request. */
function parseCommand(
  args: string[],
):
  | { command: 'list' }
  | { command: 'answer'; id: string; request: string; by: string; text: string } {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { by: { type: 'string' }, text: { type: 'string' } },
  });
  const [command, id, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected: ${rest.join(' ')}`);
  if (command === 'list') {
    if (id) throw new Error(`Unexpected: ${id}`);
    return { command };
  }
  if (command !== 'answer') throw new Error('Say what to do');
  if (!id) throw new Error('Name the request, as the list shows it');
  // As the list shows it, or as the database keeps it.
  const request = tryFromPublicId(id, 'supportRequest') ?? id;
  const by = values.by?.trim();
  if (!by) throw new Error("Say who among Hatti's people answers, with --by");
  const text = values.text?.trim();
  if (!text) throw new Error('Say what Hatti answers, with --text');
  if (text.length > SUPPORT_LIMITS.answer) {
    throw new Error(`An answer is at most ${SUPPORT_LIMITS.answer} characters`);
  }
  return { command, id, request, by, text };
}

/**
 * A request waiting, on one line: who, how urgent, when it is due, or LATE past its plan's time
 * (ADR-525), about what, and what they said.
 */
function line(request: OpenSupportRequest): string {
  return [
    toPublicId('supportRequest', request.id),
    request.createdAt.toISOString(),
    `P${request.priority}`,
    request.dueAt.getTime() <= Date.now() ? 'LATE' : `due ${request.dueAt.toISOString()}`,
    request.shopName,
    request.plan,
    request.topic,
    request.language,
    request.callBack ?? '-',
    request.message.replace(/\s+/g, ' '),
  ].join('\t');
}
