import { createHash } from 'node:crypto';
import { InputChecker, type MutationResult } from '@hatti/api';
import { Database, toDate, toDateOrNull } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Rights complaints (TNS-04, ADR-474): the owner of a trademark or copyright, or someone acting
// for them, names listings on a store that infringe it, from Hatti's page on the store itself,
// and swears in good faith that it is so. Each is due a decision from Hatti's people within 48
// hours, as reports are (ADR-460): dismissed, or upheld with what was done.

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
} as const;

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
}

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
};

const SELECT = sql`
  SELECT c.id, c.shop_id, s.name AS shop_name, s.handle AS shop_handle, c.kind, c.rights_owner,
         c.registration, c.complainant, c.acting_as, c.email, c.phone, c.listings, c.details,
         c.signature, c.sworn_at, c.language, c.status, c.due_at, c.decided_at, c.decided_by,
         c.decision, c.created_at
    FROM trust.rights_complaints c
    JOIN control.shops s ON s.id = c.shop_id`;

/** What became of a decision asked for. */
export type RightsDecided = RightsComplaintRecord | 'not_found' | 'decided';

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

  /** A complaint's decision by Hatti's people: dismissed, or upheld with what was done. Once. */
  async decide(
    id: string,
    decision: { status: 'dismissed' | 'upheld'; by: string; note: string },
    now: Date = new Date(),
  ): Promise<RightsDecided> {
    if (!isUuid(id)) return 'not_found';
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE trust.rights_complaints
           SET status = ${decision.status}, decided_at = ${now.toISOString()},
               decided_by = ${decision.by.slice(0, 100)},
               decision = ${decision.note.slice(0, 1000)}
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
  };
}
