import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  INCIDENT_IMPACTS,
  INCIDENT_KINDS,
  INCIDENT_STATUSES,
  IncidentsService,
  STATUS_COMPONENTS,
  type IncidentImpact,
  type IncidentKind,
  type IncidentRecord,
  type IncidentResult,
} from '@hatti/trust/public';
import { parseArgs } from 'node:util';
import { loadStatusIncidentsConfig } from './config.js';

// Hatti's status page (BIL-06, ADR-498), for Hatti's people: an incident posted as it begins, or
// maintenance ahead of time, saying what it touches and how badly, then updates until it ends.
// The page at /status, its JSON and every shop's admin show them at once. Words in Urdu are for
// the page's Urdu readers, and optional.
//
//   pnpm --filter @hatti/core status-incidents list [--all]
//   pnpm --filter @hatti/core status-incidents open --kind incident --impact degraded \
//     --components couriers,checkout --title "PostEx bookings failing" [--title-ur "…"] \
//     --note "Bookings with PostEx fail; we are on it." [--note-ur "…"] --by Ayesha
//   pnpm --filter @hatti/core status-incidents open --kind maintenance --impact outage \
//     --components admin --title "Database upgrade" --note "The admin is down for 20 minutes." \
//     --starts 2026-10-20T02:00+05:00 --ends 2026-10-20T02:20+05:00 --by Bilal
//   pnpm --filter @hatti/core status-incidents update inc_… --status identified \
//     --note "PostEx's API is down; bookings go through once it is back." [--impact outage] \
//     [--components couriers] --by Ayesha
//
// An incident's statuses are investigating, identified, monitoring and resolved; maintenance's
// scheduled, in_progress and completed. The last of each ends it.

const USAGE =
  'Usage: status-incidents list [--all]\n' +
  `       status-incidents open --kind <${INCIDENT_KINDS.join('|')}> --impact <${INCIDENT_IMPACTS.join('|')}>\n` +
  `           --components <${STATUS_COMPONENTS.join(',')}> --title <title> [--title-ur <title>]\n` +
  '           --note <what Hatti says> [--note-ur <in Urdu>] [--starts <time> --ends <time>] --by <who>\n' +
  `       status-incidents update <incident> --status <${[...INCIDENT_STATUSES.incident, ...INCIDENT_STATUSES.maintenance].join('|')}>\n` +
  `           --note <what Hatti says> [--note-ur <in Urdu>] [--impact <impact>] [--components <…>] --by <who>`;

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(2);
}

const { positionals, values } = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        all: { type: 'boolean' },
        kind: { type: 'string' },
        impact: { type: 'string' },
        components: { type: 'string' },
        title: { type: 'string' },
        'title-ur': { type: 'string' },
        note: { type: 'string' },
        'note-ur': { type: 'string' },
        starts: { type: 'string' },
        ends: { type: 'string' },
        status: { type: 'string' },
        by: { type: 'string' },
      },
    });
  } catch (error) {
    usage((error as Error).message);
  }
})();

const [command, given] = positionals;
if (command !== 'list' && command !== 'open' && command !== 'update') usage();
if (command === 'update' && !given) usage('Name the incident.');
const id = given && tryFromPublicId(given, 'incident');
if (given && !id) usage(`${given} is not an incident's ID: see the list.`);
if (command !== 'list' && (!values.note || !values.by)) usage('Say what Hatti says, and who.');
const impact = values.impact as IncidentImpact | undefined;
if (impact !== undefined && !(INCIDENT_IMPACTS as readonly string[]).includes(impact)) {
  usage(`The impact is one of: ${INCIDENT_IMPACTS.join(', ')}.`);
}
const kind = values.kind as IncidentKind | undefined;
if (command === 'open' && (!kind || !(INCIDENT_KINDS as readonly string[]).includes(kind))) {
  usage(`The kind is one of: ${INCIDENT_KINDS.join(', ')}.`);
}
if (command === 'open' && (!impact || !values.components || !values.title)) {
  usage('Give its impact, what it touches and a title.');
}
if (command === 'update' && !values.status) usage('Give its status.');

function time(value: string | undefined, name: string): Date | null {
  if (value === undefined) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) usage(`--${name} is not a time: ${value}`);
  return at;
}
const startsAt = time(values.starts, 'starts');
const endsAt = time(values.ends, 'ends');
const components = values.components?.split(',');

const config = loadStatusIncidentsConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'status-incidents',
});
const incidents = new IncidentsService(database);
try {
  if (command === 'list') {
    const found = await incidents.list({ all: values.all });
    if (found.length === 0) console.log(values.all ? 'No incident yet.' : 'Nothing is going on.');
    for (const incident of found) console.log(lines(incident));
  } else {
    const result: IncidentResult | 'not_found' =
      command === 'open'
        ? await incidents.open({
            kind: kind!,
            impact: impact!,
            components: components!,
            title: values.title!,
            titleUr: values['title-ur'],
            body: values.note!,
            bodyUr: values['note-ur'],
            startsAt,
            endsAt,
            by: values.by!,
          })
        : await incidents.update(id!, {
            status: values.status!,
            body: values.note!,
            bodyUr: values['note-ur'],
            impact,
            components,
            by: values.by!,
          });
    if (result === 'not_found') {
      console.error(`No incident ${given}: see the list.`);
      process.exitCode = 1;
    } else if (!result.ok) {
      console.error(result.problem);
      process.exitCode = 1;
    } else {
      console.log(lines(result.value));
    }
  }
} finally {
  await database.close();
}

function lines(incident: IncidentRecord): string {
  const latest = incident.updates.at(-1);
  return [
    `${toPublicId('incident', incident.id)}\t${incident.kind}\t${incident.impact}\t${incident.status}`,
    `  ${incident.title}${incident.titleUr ? ` / ${incident.titleUr}` : ''}`,
    `  touches ${incident.components.join(', ')}; from ${incident.startsAt.toISOString()}` +
      (incident.endsAt ? ` to ${incident.endsAt.toISOString()}` : '') +
      (incident.resolvedAt ? `; ended ${incident.resolvedAt.toISOString()}` : ''),
    latest ? `  last: ${latest.body} (${latest.postedBy}, ${latest.postedAt.toISOString()})` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
