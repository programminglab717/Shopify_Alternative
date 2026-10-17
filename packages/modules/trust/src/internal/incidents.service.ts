import { Database, type Tx } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Hatti's status page (BIL-06, ADR-498): Hatti's people post an incident, or maintenance ahead of
// time, saying which of Hatti's parts it touches and how badly, and follow it with updates until
// it ends. The core's public status page, its JSON and every shop's admin read what is going on
// now. Incidents belong to no shop: the application reads them, and the system login alone,
// through Hatti's people's command, writes them.

/** Hatti's parts, as the status page lists them. */
export const STATUS_COMPONENTS = [
  'storefronts',
  'checkout',
  'admin',
  'payments',
  'couriers',
  'whatsapp',
  'sms',
  'email',
] as const;
export type StatusComponent = (typeof STATUS_COMPONENTS)[number];

export const INCIDENT_KINDS = ['incident', 'maintenance'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** How badly what it touches works while it lasts. */
export const INCIDENT_IMPACTS = ['degraded', 'outage'] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

/** An incident's statuses, and maintenance's, in the order they usually come; the last ends it. */
export const INCIDENT_STATUSES = {
  incident: ['investigating', 'identified', 'monitoring', 'resolved'],
  maintenance: ['scheduled', 'in_progress', 'completed'],
} as const satisfies Record<IncidentKind, readonly string[]>;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[IncidentKind][number];

/** How a part works now: the worst of what touches it. */
export type ComponentState = 'operational' | 'maintenance' | 'degraded' | 'outage';

export const INCIDENT_LIMITS = {
  title: 200,
  body: 2000,
  by: 100,
  /** How long the status page goes on showing an incident after it ended. */
  recentDays: 14,
  recent: 50,
  /** How far ahead the admin's banner warns of maintenance. */
  warnHours: 24,
  /** How far ahead maintenance may be posted. */
  aheadDays: 60,
  /** How many days of each part's history the status page shows, today the last (ADR-528). */
  historyDays: 90,
  /** The most incidents the history reads, far more than 90 days have ever held. */
  history: 2000,
} as const;

/** Pakistan's offset from UTC, the same all year: the history's days are Pakistan's. */
const PKT_OFFSET_MS = 5 * 3_600_000;

export interface IncidentUpdateRecord {
  id: string;
  status: IncidentStatus;
  body: string;
  bodyUr: string | null;
  postedBy: string;
  postedAt: Date;
}

export interface IncidentRecord {
  id: string;
  kind: IncidentKind;
  impact: IncidentImpact;
  components: StatusComponent[];
  title: string;
  titleUr: string | null;
  startsAt: Date;
  endsAt: Date | null;
  resolvedAt: Date | null;
  /** The latest update's. */
  status: IncidentStatus;
  createdBy: string;
  /** The first first. */
  updates: IncidentUpdateRecord[];
}

/** What the status page shows. */
export interface StatusSnapshot {
  /** The worst of the parts'. */
  overall: ComponentState;
  components: { component: StatusComponent; state: ComponentState }[];
  /** Begun and not yet ended, the latest begun first. */
  active: IncidentRecord[];
  /** Maintenance not yet begun, the soonest first. */
  upcoming: IncidentRecord[];
  /** Ended in the last {@link INCIDENT_LIMITS.recentDays} days, the latest ended first. */
  recent: IncidentRecord[];
  /** Each part's last {@link INCIDENT_LIMITS.historyDays} days, in the order of its components. */
  history: ComponentHistory[];
}

/**
 * A part's last {@link INCIDENT_LIMITS.historyDays} days (ADR-528). Down is the time incidents
 * said it was down; maintenance posted ahead is not counted against it, nor is slowness.
 */
export interface ComponentHistory {
  component: StatusComponent;
  /** The share of the days, up to now, it was not down, in percent: rounded down, to two places. */
  uptime: number;
  /** Pakistan's days, the earliest first and today the last. */
  days: ComponentDay[];
}

export interface ComponentDay {
  /** "2026-10-17", in Pakistan's time. */
  date: string;
  /** The worst it was that day. */
  state: ComponentState;
  /** How long it was down that day, in whole minutes, rounded up. */
  downMinutes: number;
}

/** What the history needs of an incident. */
export type HistoryIncident = Pick<
  IncidentRecord,
  'kind' | 'impact' | 'components' | 'startsAt' | 'resolvedAt'
>;

export interface IncidentInput {
  kind: IncidentKind;
  impact: IncidentImpact;
  components: readonly string[];
  title: string;
  titleUr?: string | null;
  /** What Hatti says first. */
  body: string;
  bodyUr?: string | null;
  /** Maintenance's, if ahead: when it begins and is to end. Incidents begin as they are posted. */
  startsAt?: Date | null;
  endsAt?: Date | null;
  by: string;
}

export interface IncidentUpdateInput {
  status: string;
  body: string;
  bodyUr?: string | null;
  /** Changed, if it turned out better or worse than first said. */
  impact?: IncidentImpact | null;
  components?: readonly string[] | null;
  by: string;
}

export type IncidentResult = { ok: true; value: IncidentRecord } | { ok: false; problem: string };

const STATE_RANK: Record<ComponentState, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  outage: 3,
};

type IncidentRow = {
  id: string;
  kind: IncidentKind;
  impact: IncidentImpact;
  components: StatusComponent[];
  title: string;
  title_ur: string | null;
  starts_at: string | Date;
  ends_at: string | Date | null;
  resolved_at: string | Date | null;
  created_by: string;
  updates: {
    id: string;
    status: IncidentStatus;
    body: string;
    body_ur: string | null;
    posted_by: string;
    posted_at: string;
  }[];
};

const SELECT = sql`
  SELECT i.id, i.kind, i.impact, i.components, i.title, i.title_ur, i.starts_at, i.ends_at,
         i.resolved_at, i.created_by,
         (SELECT coalesce(json_agg(json_build_object(
                   'id', u.id, 'status', u.status, 'body', u.body, 'body_ur', u.body_ur,
                   'posted_by', u.posted_by, 'posted_at', u.posted_at)
                   ORDER BY u.posted_at, u.id), '[]'::json)
            FROM trust.incident_updates u WHERE u.incident_id = i.id) AS updates
    FROM trust.incidents i`;

const date = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));

function toRecord(row: IncidentRow): IncidentRecord {
  const updates = row.updates.map((update) => ({
    id: update.id,
    status: update.status,
    body: update.body,
    bodyUr: update.body_ur,
    postedBy: update.posted_by,
    postedAt: new Date(update.posted_at),
  }));
  return {
    id: row.id,
    kind: row.kind,
    impact: row.impact,
    components: row.components,
    title: row.title,
    titleUr: row.title_ur,
    startsAt: date(row.starts_at),
    endsAt: row.ends_at === null ? null : date(row.ends_at),
    resolvedAt: row.resolved_at === null ? null : date(row.resolved_at),
    status: updates.at(-1)?.status ?? INCIDENT_STATUSES[row.kind][0],
    createdBy: row.created_by,
    updates,
  };
}

/** Words as Hatti's people typed them, trimmed: null if blank, a problem if too long. */
function words(value: string | null | undefined, limit: number, name: string): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length > limit) throw new Problem(`${name} can have at most ${limit} letters.`);
  return trimmed === '' ? null : trimmed;
}

class Problem extends Error {}

function componentsOf(given: readonly string[]): StatusComponent[] {
  const wanted = [...new Set(given.map((each) => each.trim().toLowerCase()).filter(Boolean))];
  const unknown = wanted.filter((each) => !(STATUS_COMPONENTS as readonly string[]).includes(each));
  if (wanted.length === 0 || unknown.length > 0) {
    throw new Problem(`Name what it touches, of: ${STATUS_COMPONENTS.join(', ')}.`);
  }
  return STATUS_COMPONENTS.filter((each) => wanted.includes(each));
}

@Injectable()
export class IncidentsService {
  constructor(private readonly db: Database) {}

  /** An incident, begun now, or maintenance, now or ahead, with what Hatti says first. */
  async open(input: IncidentInput, now: Date = new Date()): Promise<IncidentResult> {
    try {
      const components = componentsOf(input.components);
      const title = words(input.title, INCIDENT_LIMITS.title, 'The title');
      if (!title) throw new Problem('Give it a title.');
      const body = words(input.body, INCIDENT_LIMITS.body, 'What Hatti says');
      if (!body) throw new Problem('Say what is happening.');
      const by = words(input.by, INCIDENT_LIMITS.by, 'Who');
      if (!by) throw new Problem('Say who posts it.');
      const maintenance = input.kind === 'maintenance';
      if (!maintenance && (input.startsAt || input.endsAt)) {
        throw new Problem('An incident begins as it is posted: only maintenance has times.');
      }
      const startsAt = maintenance && input.startsAt ? input.startsAt : now;
      const endsAt = (maintenance && input.endsAt) || null;
      if (startsAt.getTime() > now.getTime() + INCIDENT_LIMITS.aheadDays * 86_400_000) {
        throw new Problem(`Post maintenance at most ${INCIDENT_LIMITS.aheadDays} days ahead.`);
      }
      if (endsAt && endsAt <= startsAt) throw new Problem('It must end after it begins.');
      const status: IncidentStatus = !maintenance
        ? 'investigating'
        : startsAt > now
          ? 'scheduled'
          : 'in_progress';
      const id = await this.db.system(async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO trust.incidents (kind, impact, components, title, title_ur, starts_at,
                                       ends_at, created_by, created_at)
          VALUES (${input.kind}, ${input.impact}, ${sql.param(components)}::text[], ${title},
                  ${words(input.titleUr, INCIDENT_LIMITS.title, 'The Urdu title')},
                  ${startsAt.toISOString()}, ${endsAt?.toISOString() ?? null}, ${by},
                  ${now.toISOString()})
          RETURNING id`);
        const id = rows[0]!.id;
        await insertUpdate(tx, id, status, body, input.bodyUr, by, now);
        return id;
      });
      return { ok: true, value: (await this.find(id))! };
    } catch (error) {
      if (error instanceof Problem) return { ok: false, problem: error.message };
      throw error;
    }
  }

  /**
   * What Hatti says next of incident `id`, with its status: the last of its kind's ends it. One
   * that ended takes no more.
   */
  async update(
    id: string,
    input: IncidentUpdateInput,
    now: Date = new Date(),
  ): Promise<IncidentResult | 'not_found'> {
    if (!isUuid(id)) return 'not_found';
    try {
      const done = await this.db.system(async (tx) => {
        const { rows } = await tx.execute<{ kind: IncidentKind; resolved_at: string | null }>(
          sql`SELECT kind, resolved_at FROM trust.incidents WHERE id = ${id} FOR UPDATE`,
        );
        const found = rows[0];
        if (!found) return 'not_found' as const;
        if (found.resolved_at !== null) throw new Problem('It has ended: post a new one.');
        const statuses: readonly string[] = INCIDENT_STATUSES[found.kind];
        if (!statuses.includes(input.status)) {
          throw new Problem(`Its status is one of: ${statuses.join(', ')}.`);
        }
        const status = input.status as IncidentStatus;
        const body = words(input.body, INCIDENT_LIMITS.body, 'What Hatti says');
        if (!body) throw new Problem('Say what is happening.');
        const by = words(input.by, INCIDENT_LIMITS.by, 'Who');
        if (!by) throw new Problem('Say who posts it.');
        const components = input.components?.length ? componentsOf(input.components) : null;
        const ends = status === statuses.at(-1);
        await tx.execute(sql`
          UPDATE trust.incidents
             SET impact = coalesce(${input.impact ?? null}, impact),
                 components = coalesce(${components && sql.param(components)}::text[], components),
                 -- Maintenance begun early begins then.
                 starts_at = CASE WHEN ${status === 'in_progress'} THEN least(starts_at, ${now.toISOString()}::timestamptz)
                                  ELSE starts_at END,
                 resolved_at = CASE WHEN ${ends} THEN greatest(starts_at, ${now.toISOString()}::timestamptz) END
           WHERE id = ${id}`);
        await insertUpdate(tx, id, status, body, input.bodyUr, by, now);
        return 'done' as const;
      });
      if (done === 'not_found') return done;
      return { ok: true, value: (await this.find(id))! };
    } catch (error) {
      if (error instanceof Problem) return { ok: false, problem: error.message };
      throw error;
    }
  }

  /** Incident `id`, with all Hatti said of it. */
  async find(id: string): Promise<IncidentRecord | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.app.execute<IncidentRow>(sql`${SELECT} WHERE i.id = ${id}`);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** For Hatti's people: those not ended, the soonest begun first, or all, the latest first. */
  async list(options: { all?: boolean } = {}): Promise<IncidentRecord[]> {
    const { rows } = await this.db.app.execute<IncidentRow>(sql`
      ${SELECT}
       ${options.all ? sql`` : sql`WHERE i.resolved_at IS NULL`}
       ORDER BY ${options.all ? sql`i.starts_at DESC` : sql`i.starts_at`}, i.id
       LIMIT ${INCIDENT_LIMITS.recent}`);
    return rows.map(toRecord);
  }

  /** What the status page shows at `now`. */
  async snapshot(now: Date = new Date()): Promise<StatusSnapshot> {
    const since = new Date(now.getTime() - INCIDENT_LIMITS.recentDays * 86_400_000);
    const { rows } = await this.db.app.execute<IncidentRow>(sql`
      ${SELECT}
       WHERE i.resolved_at IS NULL OR i.resolved_at >= ${since.toISOString()}
       ORDER BY i.starts_at DESC, i.id
       LIMIT ${INCIDENT_LIMITS.recent * 2}`);
    const incidents = rows.map(toRecord);
    const active = incidents.filter((each) => each.resolvedAt === null && each.startsAt <= now);
    const upcoming = incidents
      .filter((each) => each.resolvedAt === null && each.startsAt > now)
      .reverse();
    const recent = incidents
      .filter((each) => each.resolvedAt !== null)
      .sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime());
    const history = await this.historyIncidents(now);
    const components = STATUS_COMPONENTS.map((component) => ({
      component,
      state: active
        .filter((each) => each.components.includes(component))
        .map(stateOf)
        .reduce<ComponentState>(worse, 'operational'),
    }));
    return {
      overall: components.map((each) => each.state).reduce(worse, 'operational'),
      components,
      active,
      upcoming,
      recent: recent.slice(0, INCIDENT_LIMITS.recent),
      history: historyOf(history, now),
    };
  }

  /** The incidents begun before `now` that went on within the history's days. */
  private async historyIncidents(now: Date): Promise<HistoryIncident[]> {
    const since = historyStart(now);
    const { rows } = await this.db.app.execute<{
      kind: IncidentKind;
      impact: IncidentImpact;
      components: StatusComponent[];
      starts_at: string | Date;
      resolved_at: string | Date | null;
    }>(sql`
      SELECT kind, impact, components, starts_at, resolved_at
        FROM trust.incidents
       WHERE starts_at < ${now.toISOString()}
         AND (resolved_at IS NULL OR resolved_at > ${since.toISOString()})
       ORDER BY starts_at DESC, id
       LIMIT ${INCIDENT_LIMITS.history}`);
    return rows.map((row) => ({
      kind: row.kind,
      impact: row.impact,
      components: row.components,
      startsAt: date(row.starts_at),
      resolvedAt: row.resolved_at === null ? null : date(row.resolved_at),
    }));
  }

  /**
   * What every shop's admin warns of: incidents going on, and maintenance going on or beginning
   * within {@link INCIDENT_LIMITS.warnHours} hours, the latest begun first.
   */
  async current(now: Date = new Date()): Promise<IncidentRecord[]> {
    const until = new Date(now.getTime() + INCIDENT_LIMITS.warnHours * 3_600_000);
    const { rows } = await this.db.app.execute<IncidentRow>(sql`
      ${SELECT}
       WHERE i.resolved_at IS NULL AND i.starts_at <= ${until.toISOString()}
       ORDER BY i.starts_at DESC, i.id
       LIMIT ${INCIDENT_LIMITS.recent}`);
    return rows.map(toRecord);
  }
}

/** When the history's first day began: Pakistan's midnight, {@link INCIDENT_LIMITS.historyDays} days back. */
function historyStart(now: Date): Date {
  const today = Math.floor((now.getTime() + PKT_OFFSET_MS) / 86_400_000) * 86_400_000;
  return new Date(today - (INCIDENT_LIMITS.historyDays - 1) * 86_400_000 - PKT_OFFSET_MS);
}

/**
 * Each part's history at `now` (ADR-528), from the incidents that went on in its days. An
 * incident counts by the impact it has now, from when it began until it ended, or until now.
 */
export function historyOf(incidents: readonly HistoryIncident[], now: Date): ComponentHistory[] {
  const start = historyStart(now).getTime();
  const end = now.getTime();
  const spans = incidents
    .map((incident) => ({
      incident,
      from: Math.max(incident.startsAt.getTime(), start),
      to: Math.min(incident.resolvedAt?.getTime() ?? end, end),
    }))
    .filter((span) => span.to > span.from);
  return STATUS_COMPONENTS.map((component) => {
    const touching = spans.filter((span) => span.incident.components.includes(component));
    const down = merged(
      touching
        .filter((span) => span.incident.kind === 'incident' && span.incident.impact === 'outage')
        .map((span): [number, number] => [span.from, span.to]),
    );
    const days = Array.from({ length: INCIDENT_LIMITS.historyDays }, (_, index): ComponentDay => {
      const from = start + index * 86_400_000;
      const to = Math.min(from + 86_400_000, end);
      const downMs = down.reduce(
        (sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)),
        0,
      );
      return {
        date: new Date(from + PKT_OFFSET_MS).toISOString().slice(0, 10),
        state: touching
          .filter((span) => span.from < to && span.to > from)
          .map((span) => stateOf(span.incident))
          .reduce<ComponentState>(worse, 'operational'),
        downMinutes: Math.ceil(downMs / 60_000),
      };
    });
    const downMs = down.reduce((sum, [a, b]) => sum + (b - a), 0);
    return {
      component,
      uptime: Math.floor(10_000 * (1 - downMs / Math.max(1, end - start))) / 100,
      days,
    };
  });
}

/** Time spans, those that overlap made one, the earliest first. */
function merged(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** How a part an incident touches works while it goes on. */
function stateOf(incident: Pick<IncidentRecord, 'kind' | 'impact'>): ComponentState {
  return incident.kind === 'maintenance' && incident.impact === 'degraded'
    ? 'maintenance'
    : incident.impact;
}

function worse(a: ComponentState, b: ComponentState): ComponentState {
  return STATE_RANK[b] > STATE_RANK[a] ? b : a;
}

async function insertUpdate(
  tx: Tx,
  incidentId: string,
  status: IncidentStatus,
  body: string,
  bodyUr: string | null | undefined,
  by: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO trust.incident_updates (incident_id, status, body, body_ur, posted_by, posted_at)
    VALUES (${incidentId}, ${status}, ${body},
            ${words(bodyUr, INCIDENT_LIMITS.body, 'What Hatti says in Urdu')}, ${by},
            ${now.toISOString()})`);
}
