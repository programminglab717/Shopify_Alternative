import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { takeStagedUploadIn } from '@hatti/files/public';
import { isUuid, newId } from '@hatti/ids';
import { ObjectStorage, extensionOf, sniffContentType } from '@hatti/storage';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TrustEvents } from './takedowns.service.js';

// Shops verified by Hatti (ONB-11, ADR-465): the owner asks for their identity to be verified by
// their CNIC, then the business's by its NTN, each with photos of the documents; Hatti's people
// approve or refuse each with why, and may take one back. Once decided, the photos are deleted
// and the CNIC kept as its last four digits alone. The storefront shows a shop verified (OS-11).

export type VerificationLevel = 'identity' | 'business';
export type VerificationStatus = 'waiting' | 'approved' | 'refused' | 'revoked';

export const VERIFICATION_LIMITS = {
  name: 100,
  documents: 3,
  bytes: 10 * 1024 * 1024,
  answer: 1000,
  by: 100,
  /** The requests the owner sees, the newest first. */
  listed: 10,
} as const;

/** Photos of the documents, or the PDF FBR gives. */
export const VERIFICATION_DOCUMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** How long a link to a document shows it to Hatti's people: an hour. */
export const VERIFICATION_URL_SECONDS = 3600;

/** A document kept while its request waits. */
export interface VerificationDocument {
  key: string;
  contentType: string;
  size: number;
}

export interface VerificationRecord {
  id: string;
  shopId: string;
  level: VerificationLevel;
  name: string;
  cnicLast4: string | null;
  ntn: string | null;
  status: VerificationStatus;
  askedBy: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  answer: string | null;
}

/** A request as Hatti's people review it: the CNIC in full and the documents while it waits. */
export interface VerificationReview extends VerificationRecord {
  shopName: string;
  shopHandle: string;
  cnic: string | null;
  documents: VerificationDocument[];
}

/** The shop's verification as its owner sees it: its level, and its requests. */
export interface ShopVerificationRecord {
  /** What Hatti verified and stands by: the business, which needs its owner too; or the owner. */
  level: VerificationLevel | null;
  requests: VerificationRecord[];
}

export interface VerificationInput {
  level: VerificationLevel;
  name: string;
  cnic?: string | null;
  ntn?: string | null;
  /** Staged uploads' resource URLs, the documents' photos or PDFs. */
  documents: readonly string[];
}

/** Why a decision was not made. */
export type VerificationDecisionProblem = 'not_found' | 'decided' | 'needs_identity';

export interface VerificationChangedPayload {
  verificationId: string;
  level: VerificationLevel | null;
}

type Row = {
  id: string;
  shop_id: string;
  level: VerificationLevel;
  name: string;
  cnic: string | null;
  cnic_last4: string | null;
  ntn: string | null;
  documents: VerificationDocument[];
  status: VerificationStatus;
  asked_by: string;
  created_at: string | Date;
  decided_at: string | Date | null;
  decided_by: string | null;
  answer: string | null;
  shop_name?: string;
  shop_handle?: string;
};

/** A CNIC as people write it, 12345-1234567-1, as its 13 digits; null for anything else. */
export function cnicDigits(value: string): string | null {
  const typed = value.replace(/\s/g, '');
  return /^\d{5}-?\d{7}-?\d$/.test(typed) ? typed.replace(/-/g, '') : null;
}

/** An NTN as FBR writes it, 1234567-8, or a sole proprietor's CNIC's 13 digits; null if neither. */
export function ntnOf(value: string): string | null {
  const typed = value.replace(/\s/g, '');
  const company = /^(\d{7})-?(\d)$/.exec(typed);
  if (company) return `${company[1]}-${company[2]}`;
  return cnicDigits(typed);
}

/** The shop's level in the caller's transaction `tx`: what Hatti verified and stands by. */
export async function verifiedLevelIn(tx: Tx, shopId: string): Promise<VerificationLevel | null> {
  const { rows } = await tx.execute<{ level: VerificationLevel }>(sql`
    SELECT level FROM trust.verifications WHERE shop_id = ${shopId} AND status = 'approved'`);
  const levels = new Set(rows.map((row) => row.level));
  if (!levels.has('identity')) return null;
  return levels.has('business') ? 'business' : 'identity';
}

const NOT_STAGED = 'Give the resourceUrl of an upload stagedUploadsCreate staged';
const isDocumentType = (
  type: string | null,
): type is (typeof VERIFICATION_DOCUMENT_TYPES)[number] =>
  (VERIFICATION_DOCUMENT_TYPES as readonly (string | null)[]).includes(type);

@Injectable()
export class VerificationsService {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
  ) {}

  /** The shop's level, and its latest requests, the newest first. */
  async status(tenant: TenantContext): Promise<ShopVerificationRecord> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Row>(sql`
        SELECT * FROM trust.verifications WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at DESC, id DESC LIMIT ${VERIFICATION_LIMITS.listed}`);
      return { level: await verifiedLevelIn(tx, tenant.shopId), requests: rows.map(toRecord) };
    });
  }

  /**
   * Asks Hatti to verify the shop's owner, by their CNIC, or the business, by its NTN, once its
   * owner is: with one to three photos or PDFs of the documents, staged as uploads. One request
   * waits at a time. The caller checks the asker is the shop's owner.
   */
  async submit(
    tenant: TenantContext,
    input: VerificationInput,
    askedBy: string,
    now: Date = new Date(),
  ): Promise<MutationResult<VerificationRecord>> {
    const check = new InputChecker();
    const name = check.text(['input', 'name'], input.name, {
      required: true,
      max: VERIFICATION_LIMITS.name,
    });
    let cnic: string | null = null;
    let ntn: string | null = null;
    if (input.level === 'identity') {
      cnic = cnicDigits(input.cnic ?? '');
      if (!cnic) {
        check.addMessage(
          ['input', 'cnic'],
          input.cnic?.trim() ? 'INVALID' : 'BLANK',
          'Give the CNIC’s 13 digits, like 35202-1234567-1',
        );
      }
    } else {
      ntn = ntnOf(input.ntn ?? '');
      if (!ntn) {
        check.addMessage(
          ['input', 'ntn'],
          input.ntn?.trim() ? 'INVALID' : 'BLANK',
          'Give the NTN as FBR wrote it, like 1234567-8, or the CNIC’s 13 digits for a sole proprietor',
        );
      }
    }
    if (input.documents.length === 0) {
      check.addMessage(['input', 'documents'], 'BLANK', 'Add a photo or PDF of the document');
    } else if (input.documents.length > VERIFICATION_LIMITS.documents) {
      check.addMessage(
        ['input', 'documents'],
        'TOO_MANY',
        `Add at most ${VERIFICATION_LIMITS.documents} photos or PDFs`,
      );
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    const blocked = await this.db.tenant(tenant.shopId, (tx) =>
      this.#blocked(tx, tenant.shopId, input.level),
    );
    if (blocked) return blocked;

    // Each document copied where verifications keep them, outside any transaction.
    const id = newId();
    const prefix = `shops/${tenant.shopId}/verifications/${id}/`;
    const documents: VerificationDocument[] = [];
    const uploads: { key: string; size: number }[] = [];
    const discard = () => this.storage.deletePrefix(prefix).catch(() => undefined);
    for (const [index, location] of input.documents.entries()) {
      const field = ['input', 'documents', String(index)];
      const key = this.storage.keyOf(location.trim());
      const problem = async (code: 'NOT_FOUND' | 'INVALID', message: string) => {
        await discard();
        return failOne<VerificationRecord>(field, code, message);
      };
      if (!key?.startsWith(`shops/${tenant.shopId}/files/`)) {
        return problem('NOT_FOUND', NOT_STAGED);
      }
      const head = await this.storage.head(key);
      if (!head) return problem('NOT_FOUND', 'Nothing has been uploaded to its URL yet');
      if (head.size > VERIFICATION_LIMITS.bytes) {
        return problem(
          'INVALID',
          `A document is at most ${VERIFICATION_LIMITS.bytes / 1024 / 1024} MiB`,
        );
      }
      const upload = await this.storage.read(key);
      if (!upload) return problem('NOT_FOUND', 'Nothing has been uploaded to its URL yet');
      const type = sniffContentType(upload.body);
      if (!isDocumentType(type)) {
        return problem('INVALID', 'A document is a photo (JPEG, PNG or WebP) or a PDF');
      }
      const copy = `${prefix}${index + 1}.${extensionOf(type)}`;
      await this.storage.put(copy, upload.body, type);
      documents.push({ key: copy, contentType: type, size: upload.body.length });
      uploads.push({ key, size: upload.body.length });
    }

    let result: MutationResult<VerificationRecord>;
    try {
      result = await this.db.tenant(tenant.shopId, async (tx) => {
        const again = await this.#blocked(tx, tenant.shopId, input.level);
        if (again) return again;
        for (const [index, upload] of uploads.entries()) {
          if (!(await takeStagedUploadIn(tx, tenant.shopId, upload.key, upload.size))) {
            throw new NotStaged(index);
          }
        }
        const { rows } = await tx.execute<Row>(sql`
          INSERT INTO trust.verifications
            (shop_id, id, level, name, cnic, cnic_last4, ntn, documents, asked_by, created_at)
          VALUES (${tenant.shopId}, ${id}, ${input.level}, ${name!}, ${cnic},
                  ${cnic ? cnic.slice(-4) : null}, ${ntn}, ${JSON.stringify(documents)}::jsonb,
                  ${askedBy}, ${now.toISOString()})
          RETURNING *`);
        return { ok: true, value: toRecord(rows[0]!) };
      });
    } catch (error) {
      await discard();
      if (error instanceof NotStaged) {
        return failOne(['input', 'documents', String(error.index)], 'NOT_FOUND', NOT_STAGED);
      }
      throw error;
    }
    if (!result.ok) {
      await discard();
      return result;
    }
    // The staged uploads are the request's now: their originals go.
    for (const upload of uploads) await this.storage.delete(upload.key).catch(() => undefined);
    return result;
  }

  /** Why the shop may not ask for `level` now, if it may not. */
  async #blocked(
    tx: Tx,
    shopId: string,
    level: VerificationLevel,
  ): Promise<MutationResult<never> | null> {
    const { rows } = await tx.execute<{ level: VerificationLevel; status: VerificationStatus }>(
      sql`SELECT level, status FROM trust.verifications
           WHERE shop_id = ${shopId} AND status IN ('waiting', 'approved')`,
    );
    if (rows.some((row) => row.status === 'waiting')) {
      return failOne(['input', 'level'], 'TAKEN', 'A request waits for Hatti already');
    }
    const approved = new Set(rows.map((row) => row.level));
    if (approved.has(level)) {
      return failOne(['input', 'level'], 'TAKEN', 'Hatti has verified this already');
    }
    if (level === 'business' && !approved.has('identity')) {
      return failOne(
        ['input', 'level'],
        'INVALID',
        'Hatti verifies the owner, by their CNIC, before the business',
      );
    }
    return null;
  }

  /** Requests for Hatti's people: those waiting, the oldest first, or all, the latest first. */
  async list(options: { all?: boolean; limit?: number } = {}): Promise<VerificationReview[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<Row>(sql`
        SELECT v.*, s.name AS shop_name, s.handle AS shop_handle
          FROM trust.verifications v JOIN control.shops s ON s.id = v.shop_id
         ${options.all ? sql`` : sql`WHERE v.status = 'waiting'`}
         ORDER BY ${options.all ? sql`v.created_at DESC` : sql`v.created_at`}, v.id
         LIMIT ${options.limit ?? 100}`),
    );
    return rows.map(toReview);
  }

  /** Links that show a request's documents to Hatti's people, for an hour. */
  documentLinks(review: VerificationReview): string[] {
    return review.documents.map((document) =>
      this.storage.signDownload(document.key, VERIFICATION_URL_SECONDS),
    );
  }

  /**
   * Approves a request waiting: the shop is verified at its level. A business's needs its owner
   * verified still. Its documents are deleted, and its CNIC kept as its last four digits.
   */
  async approve(
    id: string,
    input: { by: string; note?: string },
    now: Date = new Date(),
  ): Promise<VerificationReview | VerificationDecisionProblem> {
    return this.#decide(id, 'approved', input.by, input.note ?? '', now);
  }

  /** Refuses a request waiting, with why, which its owner reads. Its documents are deleted. */
  async refuse(
    id: string,
    input: { by: string; answer: string },
    now: Date = new Date(),
  ): Promise<VerificationReview | VerificationDecisionProblem> {
    if (!input.answer.trim()) throw new RangeError('Say why it is refused');
    return this.#decide(id, 'refused', input.by, input.answer, now);
  }

  async #decide(
    id: string,
    status: 'approved' | 'refused',
    by: string,
    answer: string,
    now: Date,
  ): Promise<VerificationReview | VerificationDecisionProblem> {
    if (!isUuid(id)) return 'not_found';
    const decidedBy = by.trim().slice(0, VERIFICATION_LIMITS.by);
    if (!decidedBy) throw new RangeError('Say who decided');
    const decided = await this.db.system(async (tx) => {
      const { rows } = await tx.execute<Row>(
        sql`SELECT * FROM trust.verifications WHERE id = ${id} FOR UPDATE`,
      );
      const row = rows[0];
      if (!row) return 'not_found' as const;
      if (row.status !== 'waiting') return 'decided' as const;
      if (status === 'approved' && row.level === 'business') {
        if ((await verifiedLevelIn(tx, row.shop_id)) === null) return 'needs_identity' as const;
      }
      await tx.execute(sql`
        UPDATE trust.verifications
           SET status = ${status}, decided_at = ${now.toISOString()}, decided_by = ${decidedBy},
               answer = ${answer.trim().slice(0, VERIFICATION_LIMITS.answer) || null},
               cnic = NULL, documents = '[]'
         WHERE shop_id = ${row.shop_id} AND id = ${id}`);
      if (status === 'approved') await changed(tx, row.shop_id, id);
      return reviewOf(tx, row.shop_id, id);
    });
    if (typeof decided !== 'string') await this.purge(decided);
    return decided;
  }

  /**
   * Takes back the shop's verification at `level`, with why: a business's goes with its owner's.
   * The shop `named` by its handle or ID.
   */
  async revoke(
    named: string,
    level: VerificationLevel,
    input: { by: string; answer: string },
    now: Date = new Date(),
  ): Promise<VerificationReview[] | 'not_found' | 'not_verified'> {
    const by = input.by.trim().slice(0, VERIFICATION_LIMITS.by);
    const answer = input.answer.trim().slice(0, VERIFICATION_LIMITS.answer);
    if (!by || !answer) throw new RangeError('Say who took it back, and why');
    const handle = named.trim().toLowerCase();
    return this.db.system(async (tx) => {
      const { rows: shops } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM control.shops
         WHERE ${isUuid(handle) ? sql`id = ${handle}` : sql`handle = ${handle}`}`);
      const shop = shops[0];
      if (!shop) return 'not_found' as const;
      const levels = level === 'identity' ? ['identity', 'business'] : ['business'];
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE trust.verifications
           SET status = 'revoked', decided_at = ${now.toISOString()}, decided_by = ${by},
               answer = ${answer}
         WHERE shop_id = ${shop.id} AND status = 'approved'
           AND level IN (${sql.join(
             levels.map((each) => sql`${each}`),
             sql`, `,
           )})
        RETURNING id`);
      if (rows.length === 0) return 'not_verified' as const;
      await changed(tx, shop.id, rows[0]!.id);
      return Promise.all(rows.map((row) => reviewOf(tx, shop.id, row.id)));
    });
  }

  /** Deletes what storage keeps of a decided request's documents. */
  async purge(review: Pick<VerificationRecord, 'shopId' | 'id'>): Promise<void> {
    await this.storage.deletePrefix(`shops/${review.shopId}/verifications/${review.id}/`);
  }
}

class NotStaged extends Error {
  constructor(readonly index: number) {
    super('Not staged');
  }
}

/** The shop's level changed: its storefront's document says it again. */
async function changed(tx: Tx, shopId: string, verificationId: string): Promise<void> {
  await appendEvent<VerificationChangedPayload>(tx, shopId, {
    type: TrustEvents.VerificationChanged,
    aggregateType: 'shop',
    aggregateId: shopId,
    payload: { verificationId, level: await verifiedLevelIn(tx, shopId) },
  });
}

async function reviewOf(tx: Tx, shopId: string, id: string): Promise<VerificationReview> {
  const { rows } = await tx.execute<Row>(sql`
    SELECT v.*, s.name AS shop_name, s.handle AS shop_handle
      FROM trust.verifications v JOIN control.shops s ON s.id = v.shop_id
     WHERE v.shop_id = ${shopId} AND v.id = ${id}`);
  return toReview(rows[0]!);
}

function toRecord(row: Row): VerificationRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    level: row.level,
    name: row.name,
    cnicLast4: row.cnic_last4,
    ntn: row.ntn,
    status: row.status,
    askedBy: row.asked_by,
    createdAt: toDate(row.created_at),
    decidedAt: toDateOrNull(row.decided_at),
    decidedBy: row.decided_by,
    answer: row.answer,
  };
}

function toReview(row: Row): VerificationReview {
  return {
    ...toRecord(row),
    shopName: row.shop_name ?? '',
    shopHandle: row.shop_handle ?? '',
    cnic: row.cnic,
    documents: row.documents,
  };
}
