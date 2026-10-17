import { createHash } from 'node:crypto';
import { InputChecker, type MutationResult } from '@hatti/api';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Rights complaints (TNS-04, ADR-474): the owner of a trademark or copyright, or someone acting
// for them, names listings on a store that infringe it, from Hatti's page on the store itself,
// and swears in good faith that it is so. Each is due a decision from Hatti's people within 48
// hours, as reports are (ADR-460): dismissed, or upheld with what was done. One upheld sends the
// store's owner a link of its own (ADR-476), whose page shows the complaint and takes their sworn
// counter-notice, once; Hatti's people refuse it with why, or let the listings go.

/** Where rights complaints' links are, on the core's own address: /rights/<token>. */
export const RIGHTS_LINK_PATH = 'rights';

/** A new rights link's secret: 24 random bytes, 32 characters. */
export function rightsLinkToken(): string {
  return secretToken('', 24);
}

const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export const RIGHTS_KINDS = ['trademark', 'copyright', 'counterfeit'] as const;
export type RightsKind = (typeof RIGHTS_KINDS)[number];

export const RIGHTS_ACTING_AS = ['owner', 'agent'] as const;
export type RightsActingAs = (typeof RIGHTS_ACTING_AS)[number];

export const RIGHTS_STATUSES = ['open', 'dismissed', 'upheld'] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

export const RIGHTS_LIMITS = {
  /** A decision is due this long after a complaint comes. */
  dueMs: 48 * 3_600_000,
  name: 200,
  registration: 100,
  details: 2000,
  /** Listings one complaint names. */
  listings: 20,
  title: 255,
  url: 500,
  /** Complaints of one store from one address a day, past which more are not taken. */
  perClientPerDay: 5,
  /** A counter-notice's words, and Hatti's answer to it or note on letting the listings go. */
  counter: 2000,
  answer: 1000,
  by: 100,
} as const;

/** Where a counter-notice stands: waiting for Hatti, refused, or upheld by letting go. */
export type RightsCounterStatus = 'open' | 'refused' | 'upheld';

/** A listing a complaint names, as the store showed it. */
export interface RightsListing {
  /** The product's ID. */
  id: string;
  title: string;
  url: string;
}

/** What a complainant sends from the store's rights page. */
export interface RightsComplaintInput {
  kind: string | null;
  rightsOwner: string | null;
  registration?: string | null;
  complainant: string | null;
  actingAs: string | null;
  email: string | null;
  phone?: string | null;
  listings: readonly RightsListing[];
  details: string | null;
  signature: string | null;
  /** That they swore the statement in good faith. */
  sworn: boolean;
  /** The complainant's address, kept only as a hash with the shop's. */
  client?: string | null;
  language?: 'en' | 'ur';
}

/** A complaint, as Hatti's people see it. */
export interface RightsComplaintRecord {
  id: string;
  shopId: string;
  shopName: string;
  shopHandle: string;
  kind: RightsKind;
  rightsOwner: string;
  registration: string | null;
  complainant: string;
  actingAs: RightsActingAs;
  email: string;
  phone: string | null;
  listings: RightsListing[];
  details: string;
  signature: string;
  swornAt: Date;
  language: 'en' | 'ur';
  status: RightsStatus;
  dueAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decision: string | null;
  createdAt: Date;
  /** The store owner's counter-notice, if they sent one. */
  counterWords: string | null;
  counterSignature: string | null;
  counteredAt: Date | null;
  counterStatus: RightsCounterStatus | null;
  counterAnswer: string | null;
  counterAnsweredAt: Date | null;
  counterAnsweredBy: string | null;
  /** When Hatti's people let its listings go, who and why. */
  releasedAt: Date | null;
  releasedBy: string | null;
  releaseNote: string | null;
}

/** What a rights link's page shows the store's owner. */
export interface RightsView {
  shopName: string;
  kind: RightsKind;
  rightsOwner: string;
  registration: string | null;
  complainant: string;
  email: string;
  listings: RightsListing[];
  details: string;
  /** Hatti's words on taking the listings down. */
  decision: string;
  decidedAt: Date;
  counter: {
    words: string;
    status: RightsCounterStatus;
    answer: string | null;
    at: Date;
  } | null;
  releasedAt: Date | null;
  releaseNote: string | null;
  /** None sent yet, and the listings still held. */
  canCounter: boolean;
}

/** Why a counter-notice was not taken. */
export type RightsCounterProblem =
  'blank' | 'too_long' | 'unsigned' | 'unsworn' | 'countered' | 'released';

export type RightsCounterResult =
  { ok: true; view: RightsView } | { ok: false; problem: RightsCounterProblem; view: RightsView };

type RightsRow = {
  id: string;
  shop_id: string;
  shop_name: string;
  shop_handle: string;
  kind: RightsKind;
  rights_owner: string;
  registration: string | null;
  complainant: string;
  acting_as: RightsActingAs;
  email: string;
  phone: string | null;
  listings: RightsListing[];
  details: string;
  signature: string;
  sworn_at: string | Date;
  language: 'en' | 'ur';
  status: RightsStatus;
  due_at: string | Date;
  decided_at: string | Date | null;
  decided_by: string | null;
  decision: string | null;
  created_at: string | Date;
  counter_words: string | null;
  counter_signature: string | null;
  countered_at: string | Date | null;
  counter_status: RightsCounterStatus | null;
  counter_answer: string | null;
  counter_answered_at: string | Date | null;
  counter_answered_by: string | null;
  released_at: string | Date | null;
  released_by: string | null;
  release_note: string | null;
};

const SELECT = sql`
  SELECT c.id, c.shop_id, s.name AS shop_name, s.handle AS shop_handle, c.kind, c.rights_owner,
         c.registration, c.complainant, c.acting_as, c.email, c.phone, c.listings, c.details,
         c.signature, c.sworn_at, c.language, c.status, c.due_at, c.decided_at, c.decided_by,
         c.decision, c.created_at, c.counter_words, c.counter_signature, c.countered_at,
         c.counter_status, c.counter_answer, c.counter_answered_at, c.counter_answered_by,
         c.released_at, c.released_by, c.release_note
    FROM trust.rights_complaints c
    JOIN control.shops s ON s.id = c.shop_id`;

/** What became of a decision asked for. */
export type RightsDecided = RightsComplaintRecord | 'not_found' | 'decided';

/** What became of a counter-notice's refusal, or of listings let go. */
export type RightsAnswered = RightsComplaintRecord | 'not_found' | 'not_upheld' | 'answered';

/** The complainant's address, hashed with the shop's: the same person, not who. */
function clientHash(shopId: string, client: string): string {
  return createHash('sha256').update(`rights:${shopId}:${client}`).digest('hex').slice(0, 32);
}

@Injectable()
export class RightsComplaintsService {
  constructor(private readonly db: Database) {}

  /**
   * Takes a rights owner's complaint of listings on the shop's store: whose right and what, who
   * complains and how to reach them, the listings, and the statement they swore; due a decision in
   * 48 hours. One address complains of one store five times a day at most.
   */
  async complain(
    shopId: string,
    input: RightsComplaintInput,
    now: Date = new Date(),
  ): Promise<MutationResult<{ id: string }>> {
    const check = new InputChecker();
    const kind = input.kind?.trim() ?? '';
    if (!(RIGHTS_KINDS as readonly string[]).includes(kind)) {
      check.addMessage(['kind'], 'INVALID', 'Say what right the listings infringe');
    }
    const rightsOwner = check.text(['rightsOwner'], input.rightsOwner, {
      max: RIGHTS_LIMITS.name,
      required: true,
    });
    const registration = check.text(['registration'], input.registration, {
      max: RIGHTS_LIMITS.registration,
    });
    const complainant = check.text(['complainant'], input.complainant, {
      max: RIGHTS_LIMITS.name,
      required: true,
    });
    const actingAs = input.actingAs?.trim() ?? '';
    if (!(RIGHTS_ACTING_AS as readonly string[]).includes(actingAs)) {
      check.addMessage(
        ['actingAs'],
        'INVALID',
        'Say whether you own the right or act for its owner',
      );
    }
    if (!input.email?.trim()) check.addMessage(['email'], 'BLANK', 'Give an email to reach you at');
    const email = check.email(['email'], input.email);
    const phone = check.mobile(['phone'], input.phone);
    const listings = input.listings.filter((listing) => isUuid(listing.id));
    if (listings.length === 0 || listings.length !== input.listings.length) {
      check.addMessage(['listings'], 'INVALID', "Name the store's listings by their addresses");
    } else if (listings.length > RIGHTS_LIMITS.listings) {
      check.addMessage(
        ['listings'],
        'TOO_MANY',
        `Name at most ${RIGHTS_LIMITS.listings} listings in one complaint`,
      );
    }
    const details = check.text(['details'], input.details, {
      max: RIGHTS_LIMITS.details,
      required: true,
    });
    const signature = check.text(['signature'], input.signature, {
      max: RIGHTS_LIMITS.name,
      required: true,
    });
    if (!input.sworn) {
      check.addMessage(['sworn'], 'INVALID', 'Swear the statement to send the complaint');
    }
    if (!check.ok || !rightsOwner || !complainant || !email || !details || !signature) {
      return { ok: false, errors: check.errors };
    }
    const kept = [...new Map(listings.map((listing) => [listing.id, listing])).values()].map(
      (listing) => ({
        id: listing.id,
        title: listing.title.slice(0, RIGHTS_LIMITS.title),
        url: listing.url.slice(0, RIGHTS_LIMITS.url),
      }),
    );
    const hash = input.client ? clientHash(shopId, input.client) : null;

    return this.db.tenant(shopId, async (tx) => {
      const { rows: shops } = await tx.execute<{ id: string }>(
        sql`SELECT id FROM control.shops WHERE id = ${shopId}`,
      );
      if (shops.length === 0) {
        return {
          ok: false,
          errors: [{ field: ['base'], code: 'NOT_FOUND', message: 'No such store' }],
        };
      }
      if (hash) {
        const { rows } = await tx.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count FROM trust.rights_complaints
           WHERE shop_id = ${shopId} AND client_hash = ${hash}
             AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
        if (rows[0]!.count >= RIGHTS_LIMITS.perClientPerDay) {
          return {
            ok: false,
            errors: [
              {
                field: ['base'],
                code: 'INVALID',
                message:
                  'You have sent this store enough complaints today already: Hatti is looking into them',
              },
            ],
          };
        }
      }
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO trust.rights_complaints
               (shop_id, kind, rights_owner, registration, complainant, acting_as, email, phone,
                listings, details, signature, sworn_at, client_hash, language, due_at, created_at)
        VALUES (${shopId}, ${kind}, ${rightsOwner}, ${registration}, ${complainant}, ${actingAs},
                ${email}, ${phone}, ${JSON.stringify(kept)}::jsonb, ${details}, ${signature},
                ${now.toISOString()}, ${hash}, ${input.language ?? 'en'},
                ${new Date(now.getTime() + RIGHTS_LIMITS.dueMs).toISOString()},
                ${now.toISOString()})
        RETURNING id`);
      return { ok: true, value: { id: rows[0]!.id } };
    });
  }

  /**
   * Complaints for Hatti's people, with the system login, which sees every shop's: those open,
   * the soonest due first, or all, the latest first.
   */
  async list(options: { all?: boolean; limit?: number } = {}): Promise<RightsComplaintRecord[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<RightsRow>(sql`
        ${SELECT}
         ${options.all ? sql`` : sql`WHERE c.status = 'open'`}
         ORDER BY ${options.all ? sql`c.created_at DESC` : sql`c.due_at`}, c.id
         LIMIT ${options.limit ?? 100}`),
    );
    return rows.map(toRecord);
  }

  /** One complaint, for Hatti's people. */
  async get(id: string): Promise<RightsComplaintRecord | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.system((tx) =>
      tx.execute<RightsRow>(sql`${SELECT} WHERE c.id = ${id}`),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * A complaint's decision by Hatti's people: dismissed, or upheld with what was done, and the
   * secret of the link its store's owner answers it by (ADR-476). Once.
   */
  async decide(
    id: string,
    decision: { status: 'dismissed' | 'upheld'; by: string; note: string; linkToken?: string },
    now: Date = new Date(),
  ): Promise<RightsDecided> {
    if (!isUuid(id)) return 'not_found';
    const digest =
      decision.status === 'upheld' && decision.linkToken ? sha256(decision.linkToken) : null;
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE trust.rights_complaints
           SET status = ${decision.status}, decided_at = ${now.toISOString()},
               decided_by = ${decision.by.slice(0, 100)},
               decision = ${decision.note.slice(0, 1000)}, link_digest = ${digest}
         WHERE id = ${id} AND status = 'open'
        RETURNING id`);
      if (rows.length === 0) {
        const { rows: found } = await tx.execute<{ id: string }>(
          sql`SELECT id FROM trust.rights_complaints WHERE id = ${id}`,
        );
        return found.length === 0 ? 'not_found' : 'decided';
      }
      const { rows: decided } = await tx.execute<RightsRow>(sql`${SELECT} WHERE c.id = ${id}`);
      return toRecord(decided[0]!);
    });
  }

  /** What the rights link `token` shows its store's owner; null for a link that names none. */
  async view(token: string): Promise<RightsView | null> {
    const link = await this.#resolve(token);
    if (!link) return null;
    return this.db.tenant(link.shopId, async (tx) => {
      const complaint = await complaintOf(tx, link);
      return complaint && viewOf(complaint);
    });
  }

  /**
   * Takes the store owner's counter-notice through the link: their side, sworn in good faith and
   * signed with their name; once, while the listings are held. Null for a link that names none.
   */
  async counter(
    token: string,
    input: { words: string; signature: string; sworn: boolean },
    now: Date = new Date(),
  ): Promise<RightsCounterResult | null> {
    const link = await this.#resolve(token);
    if (!link) return null;
    return this.db.tenant(link.shopId, async (tx) => {
      const complaint = await complaintOf(tx, link, true);
      if (!complaint) return null;
      const view = viewOf(complaint);
      const words = input.words.trim();
      const signature = input.signature.trim();
      let problem: RightsCounterProblem | null = null;
      if (complaint.releasedAt) problem = 'released';
      else if (complaint.counterWords) problem = 'countered';
      else if (!words) problem = 'blank';
      else if (words.length > RIGHTS_LIMITS.counter) problem = 'too_long';
      else if (!input.sworn) problem = 'unsworn';
      else if (!signature || signature.length > RIGHTS_LIMITS.name) problem = 'unsigned';
      if (problem) return { ok: false, problem, view };
      await tx.execute(sql`
        UPDATE trust.rights_complaints
           SET counter_words = ${words}, counter_signature = ${signature},
               countered_at = ${now.toISOString()}, counter_status = 'open'
         WHERE shop_id = ${link.shopId} AND id = ${link.complaintId}`);
      return { ok: true, view: viewOf((await complaintOf(tx, link))!) };
    });
  }

  /**
   * The complaint a link's secret belongs to, found without knowing the shop, through the
   * database's function: requests have no system login.
   */
  async #resolve(token: string): Promise<RightsLink | null> {
    if (!TOKEN.test(token)) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; complaint_id: string }>(
      sql`SELECT * FROM trust.resolve_rights_link(${sha256(token)})`,
    );
    const row = rows[0];
    return row ? { shopId: row.shop_id, complaintId: row.complaint_id } : null;
  }

  /**
   * Counter-notices for Hatti's people: those waiting, the oldest first, or all sent, the latest
   * first.
   */
  async counters(
    options: { all?: boolean; limit?: number } = {},
  ): Promise<RightsComplaintRecord[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<RightsRow>(sql`
        ${SELECT}
         WHERE ${options.all ? sql`c.counter_status IS NOT NULL` : sql`c.counter_status = 'open'`}
         ORDER BY ${options.all ? sql`c.countered_at DESC` : sql`c.countered_at`}, c.id
         LIMIT ${options.limit ?? 100}`),
    );
    return rows.map(toRecord);
  }

  /** Refuses a counter-notice waiting, with why, which the link's page shows the owner. Once. */
  async refuseCounter(
    id: string,
    input: { by: string; answer: string },
    now: Date = new Date(),
  ): Promise<RightsAnswered> {
    const by = input.by.trim().slice(0, RIGHTS_LIMITS.by);
    const answer = input.answer.trim().slice(0, RIGHTS_LIMITS.answer);
    if (!by || !answer) throw new RangeError('Say who refused it, and why');
    return this.#answer(id, (tx) =>
      tx.execute<{ id: string }>(sql`
        UPDATE trust.rights_complaints
           SET counter_status = 'refused', counter_answered_at = ${now.toISOString()},
               counter_answered_by = ${by}, counter_answer = ${answer}
         WHERE id = ${id} AND counter_status = 'open' AND released_at IS NULL
        RETURNING id`),
    );
  }

  /**
   * Lets an upheld complaint's listings go, by Hatti's people, with why: once the complaint is
   * withdrawn or settled, or its counter-notice is upheld, as one waiting then is. Once. The
   * catalog's hold is the caller's to lift.
   */
  async release(
    id: string,
    input: { by: string; note: string },
    now: Date = new Date(),
  ): Promise<RightsAnswered> {
    const by = input.by.trim().slice(0, RIGHTS_LIMITS.by);
    const note = input.note.trim().slice(0, RIGHTS_LIMITS.answer);
    if (!by || !note) throw new RangeError('Say who let them go, and why');
    return this.#answer(id, (tx) =>
      tx.execute<{ id: string }>(sql`
        UPDATE trust.rights_complaints
           SET released_at = ${now.toISOString()}, released_by = ${by}, release_note = ${note},
               counter_status = CASE WHEN counter_status = 'open' THEN 'upheld'
                                     ELSE counter_status END,
               counter_answered_at = CASE WHEN counter_status = 'open' THEN ${now.toISOString()}::timestamptz
                                          ELSE counter_answered_at END,
               counter_answered_by = CASE WHEN counter_status = 'open' THEN ${by}
                                          ELSE counter_answered_by END,
               counter_answer = CASE WHEN counter_status = 'open' THEN ${note}
                                     ELSE counter_answer END
         WHERE id = ${id} AND status = 'upheld' AND released_at IS NULL
        RETURNING id`),
    );
  }

  async #answer(
    id: string,
    update: (tx: Tx) => Promise<{ rows: { id: string }[] }>,
  ): Promise<RightsAnswered> {
    if (!isUuid(id)) return 'not_found';
    return this.db.system(async (tx) => {
      const { rows } = await update(tx);
      if (rows.length === 0) {
        const { rows: found } = await tx.execute<{ status: RightsStatus }>(
          sql`SELECT status FROM trust.rights_complaints WHERE id = ${id}`,
        );
        if (found.length === 0) return 'not_found';
        return found[0]!.status === 'upheld' ? 'answered' : 'not_upheld';
      }
      const { rows: answered } = await tx.execute<RightsRow>(sql`${SELECT} WHERE c.id = ${id}`);
      return toRecord(answered[0]!);
    });
  }
}

interface RightsLink {
  shopId: string;
  complaintId: string;
}

async function complaintOf(
  tx: Tx,
  link: RightsLink,
  lock = false,
): Promise<RightsComplaintRecord | null> {
  const { rows } = await tx.execute<RightsRow>(sql`
    ${SELECT} WHERE c.shop_id = ${link.shopId} AND c.id = ${link.complaintId}
    ${lock ? sql`FOR UPDATE OF c` : sql``}`);
  return rows[0] ? toRecord(rows[0]) : null;
}

function viewOf(complaint: RightsComplaintRecord): RightsView {
  return {
    shopName: complaint.shopName,
    kind: complaint.kind,
    rightsOwner: complaint.rightsOwner,
    registration: complaint.registration,
    complainant: complaint.complainant,
    email: complaint.email,
    listings: complaint.listings,
    details: complaint.details,
    decision: complaint.decision ?? '',
    decidedAt: complaint.decidedAt ?? complaint.createdAt,
    counter:
      complaint.counterWords && complaint.counterStatus && complaint.counteredAt
        ? {
            words: complaint.counterWords,
            status: complaint.counterStatus,
            answer: complaint.counterAnswer,
            at: complaint.counteredAt,
          }
        : null,
    releasedAt: complaint.releasedAt,
    releaseNote: complaint.releaseNote,
    canCounter: !complaint.counterWords && !complaint.releasedAt,
  };
}

function toRecord(row: RightsRow): RightsComplaintRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopName: row.shop_name,
    shopHandle: row.shop_handle,
    kind: row.kind,
    rightsOwner: row.rights_owner,
    registration: row.registration,
    complainant: row.complainant,
    actingAs: row.acting_as,
    email: row.email,
    phone: row.phone,
    listings: row.listings,
    details: row.details,
    signature: row.signature,
    swornAt: toDate(row.sworn_at),
    language: row.language,
    status: row.status,
    dueAt: toDate(row.due_at),
    decidedAt: toDateOrNull(row.decided_at),
    decidedBy: row.decided_by,
    decision: row.decision,
    createdAt: toDate(row.created_at),
    counterWords: row.counter_words,
    counterSignature: row.counter_signature,
    counteredAt: toDateOrNull(row.countered_at),
    counterStatus: row.counter_status,
    counterAnswer: row.counter_answer,
    counterAnsweredAt: toDateOrNull(row.counter_answered_at),
    counterAnsweredBy: row.counter_answered_by,
    releasedAt: toDateOrNull(row.released_at),
    releasedBy: row.released_by,
    releaseNote: row.release_note,
  };
}
