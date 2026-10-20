import {
  InputChecker,
  fail,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { ObjectStorage, maxUploadBytesOf } from '@hatti/storage';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, lt, sql } from 'drizzle-orm';
import {
  FileEvents,
  type FileCreatedPayload,
  type FileDeletedPayload,
  type FileUpdatedPayload,
} from './events.js';
import {
  FILE_TYPES,
  SNIFF_BYTES,
  isFileType,
  keyName,
  looksLike,
  shownFilePrefixOf,
  type FileTypeValue,
} from './file-types.js';
import type { FileRecord, Page, StagedUpload } from './records.js';
import { files, type FileRow } from './schema.js';

export const FILE_LIMITS = { filename: 255, alt: 512, perRequest: 10 } as const;

/** How long a staged upload's URL takes an upload: an hour. */
export const UPLOAD_SECONDS = 3600;

/** How long a file's URL shows it: an hour. */
export const FILE_URL_SECONDS = 3600;

/** Staged uploads never made files are deleted after a day, some each time a shop stages more. */
/** A files search's longest, and how many of its words count (ADR-636). */
const FILE_SEARCH_MOST = 255;
const FILE_SEARCH_WORDS = 10;

const STAGED_HOURS = 24;
const SWEEP = 100;

export interface StagedUploadInput {
  filename: string;
  /** "image/jpeg", "image/png", "image/webp", "image/gif" or "application/pdf". */
  mimeType: string;
  /** Bytes, as a decimal string, as Shopify takes it: "123456". */
  fileSize: string;
}

/**
 * A file's name or words for what it shows, changed (ADR-638), or what it holds replaced by a
 * staged upload's (ADR-647); what is left out stays.
 */
export interface FileUpdateInput {
  id: string;
  filename?: string | null;
  alt?: string | null;
  /** A staged upload's `resourceUrl`: the file holds it in place of what it held. */
  originalSource?: string | null;
}

export interface FileCreateInput {
  /** A staged upload's `resourceUrl`. */
  originalSource: string;
  alt?: string | null;
}

/**
 * Files a shop uploads (ADR-079): staged, each with a URL its client uploads the bytes to
 * straight, as Shopify's `stagedUploadsCreate` gives; then made files once the upload is in, of
 * the size and the type it was staged as, as `fileCreate` does. Storage keeps each under the
 * shop's own prefix, and shows it only through short-lived signed URLs.
 */
@Injectable()
export class FileService {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
  ) {}

  /** Stages uploads of the files `inputs` describe: where to upload each, for an hour. */
  async stage(
    tenant: TenantContext,
    inputs: StagedUploadInput[],
  ): Promise<MutationResult<StagedUpload[]>> {
    const check = new InputChecker();
    countOf(check, ['input'], inputs.length);
    const staged = inputs.map((input, index) =>
      checkStaged(check, ['input', String(index)], input),
    );
    if (!check.ok) return fail(check.errors);
    const { swept, uploads } = await this.db.tenant(tenant.shopId, async (tx) => {
      const swept = await sweep(tx, tenant.shopId);
      const uploads: StagedUpload[] = [];
      for (const file of staged as NonNullable<(typeof staged)[number]>[]) {
        const id = newId();
        const key = `shops/${tenant.shopId}/files/${id}/${keyName(file.filename, file.type)}`;
        await tx.insert(files).values({
          shopId: tenant.shopId,
          id,
          key,
          filename: file.filename,
          contentType: file.type,
          size: file.size,
        });
        const upload = this.storage.signUpload(
          key,
          { contentType: file.type, contentLength: file.size },
          UPLOAD_SECONDS,
        );
        uploads.push({ ...upload, resourceUrl: this.storage.locationOf(key) });
      }
      return { swept, uploads };
    });
    await this.#remove(swept);
    return { ok: true, value: uploads };
  }

  /**
   * Makes files of staged uploads, by their resource URLs, once each is in storage, of the size
   * and type it was staged as: a file not what it said it was is removed. Records `file.created`
   * for each; one made already is given as it is.
   */
  async create(
    tenant: TenantContext,
    inputs: FileCreateInput[],
  ): Promise<MutationResult<FileRecord[]>> {
    const check = new InputChecker();
    countOf(check, ['files'], inputs.length);
    const alts = inputs.map(
      (input, index) =>
        check.text(['files', String(index), 'alt'], input.alt, { max: FILE_LIMITS.alt }) ?? '',
    );
    if (!check.ok) return fail(check.errors);
    const prefix = `shops/${tenant.shopId}/files/`;
    const keys = inputs.map((input) => {
      const key = this.storage.keyOf(input.originalSource.trim());
      return key?.startsWith(prefix) ? key : null;
    });
    const known = keys.filter((key) => key !== null);
    const found =
      known.length === 0
        ? []
        : await this.db.tenant(tenant.shopId, (tx) =>
            tx
              .select()
              .from(files)
              .where(and(eq(files.shopId, tenant.shopId), inArray(files.key, known))),
          );
    const byKey = new Map(found.map((row) => [row.key, row]));
    // Storage is asked outside the transaction, which holds nothing while it answers.
    const errors: FieldError[] = [];
    const removed: string[] = [];
    for (const [index, key] of keys.entries()) {
      const field = ['files', String(index), 'originalSource'];
      const row = key === null ? undefined : byKey.get(key);
      if (!row) {
        errors.push({
          field,
          code: 'NOT_FOUND',
          message: NOT_STAGED,
        });
      } else if (row.status === 'staged') {
        const problem = await this.#problemWith(row);
        if (problem) {
          errors.push({ field, code: 'INVALID', message: problem });
          if (problem !== NOT_UPLOADED) removed.push(row.key);
        }
      }
    }
    if (errors.length > 0) {
      await this.#remove(removed);
      return fail(errors);
    }
    const made = await this.db.tenant(tenant.shopId, async (tx) => {
      const records: FileRecord[] = [];
      for (const [index, key] of keys.entries()) {
        const row = byKey.get(key!)!;
        const [ready] = await tx
          .update(files)
          .set({ status: 'ready', alt: alts[index]!, updatedAt: sql`now()` })
          .where(
            and(eq(files.shopId, tenant.shopId), eq(files.id, row.id), eq(files.status, 'staged')),
          )
          .returning();
        if (ready) {
          await appendEvent<FileCreatedPayload>(tx, tenant.shopId, {
            type: FileEvents.FileCreated,
            aggregateType: 'file',
            aggregateId: ready.id,
            payload: { contentType: ready.contentType, size: ready.size },
          });
        }
        records.push(toRecord(ready ?? row));
      }
      return records;
    });
    return { ok: true, value: made };
  }

  /**
   * The shop's files, newest first; with `query`, those whose names hold each of its words, in
   * any case (ADR-636): "lawn eid" finds "Eid lawn banner.jpg".
   */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null; query?: string | null },
  ): Promise<Page<FileRecord>> {
    // No filename has control characters, and Postgres refuses some.
    const words = (options.query ?? '')
      .replace(/\p{Cc}/gu, '')
      .slice(0, FILE_SEARCH_MOST)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, FILE_SEARCH_WORDS);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(files)
        .where(
          and(
            eq(files.shopId, tenant.shopId),
            eq(files.status, 'ready'),
            options.after ? lt(files.id, options.after) : undefined,
            ...words.map((word) =>
              ilike(files.filename, `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`),
            ),
          ),
        )
        .orderBy(desc(files.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<FileRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(files)
        .where(and(eq(files.shopId, tenant.shopId), eq(files.id, id), eq(files.status, 'ready')));
      return row ? toRecord(row) : null;
    });
  }

  /**
   * Renames files, or changes the words for what they show (ADR-638), or replaces what they hold
   * with a staged upload's (ADR-647), up to ten at a time. A name keeps its extension, as
   * Shopify's `fileUpdate` asks, so its type never seems to change: a file replaced takes its
   * upload's name, and an image is replaced by an image, any other by one of its type. A file
   * replaced keeps its ID, so whatever uses it shows the new one; what storage kept of the old
   * one is removed. Records `file.updated` for each that changed.
   */
  async update(
    tenant: TenantContext,
    inputs: FileUpdateInput[],
  ): Promise<MutationResult<FileRecord[]>> {
    const check = new InputChecker();
    countOf(check, ['files'], inputs.length);
    const prefix = `shops/${tenant.shopId}/files/`;
    const changes = inputs.map((input, index) => {
      const field = ['files', String(index)];
      const filename =
        input.filename === undefined || input.filename === null
          ? undefined
          : check.text([...field, 'filename'], input.filename, {
              required: true,
              max: FILE_LIMITS.filename,
            });
      const alt =
        input.alt === undefined || input.alt === null
          ? undefined
          : (check.text([...field, 'alt'], input.alt, { max: FILE_LIMITS.alt }) ?? '');
      const source = input.originalSource?.trim();
      const key = source ? this.storage.keyOf(source) : undefined;
      return {
        id: input.id,
        filename: filename ?? undefined,
        alt,
        // A source that is none of the shop's staged uploads is null.
        key:
          source === undefined || source === '' ? undefined : key?.startsWith(prefix) ? key : null,
      };
    });
    if (!check.ok) return fail(check.errors);
    // The uploads replacing files, checked in storage outside the transaction, as `create` does.
    const keys = changes.flatMap((change) => (change.key ? [change.key] : []));
    const staged =
      keys.length === 0
        ? []
        : await this.db.tenant(tenant.shopId, (tx) =>
            tx
              .select()
              .from(files)
              .where(
                and(
                  eq(files.shopId, tenant.shopId),
                  inArray(files.key, keys),
                  eq(files.status, 'staged'),
                ),
              ),
          );
    const stagedByKey = new Map(staged.map((row) => [row.key, row]));
    const errors: FieldError[] = [];
    const unusable: string[] = [];
    for (const [index, change] of changes.entries()) {
      if (change.key === undefined) continue;
      const field = ['files', String(index), 'originalSource'];
      const row = change.key === null ? undefined : stagedByKey.get(change.key);
      const problem = row ? await this.#problemWith(row) : null;
      if (!row) {
        errors.push({ field, code: 'NOT_FOUND', message: NOT_STAGED });
      } else if (problem) {
        errors.push({ field, code: 'INVALID', message: problem });
        if (problem !== NOT_UPLOADED) unusable.push(row.key);
      }
    }
    if (new Set(keys).size !== keys.length) {
      errors.push({ field: ['files'], code: 'INVALID', message: 'Give each upload once' });
    }
    if (errors.length > 0) {
      await this.#remove(unusable);
      return fail(errors);
    }
    const result = await this.db
      .tenant(tenant.shopId, async (tx): Promise<Replaced> => {
        const ids = changes.map((change) => change.id);
        const found = await tx
          .select()
          .from(files)
          .where(
            and(eq(files.shopId, tenant.shopId), inArray(files.id, ids), eq(files.status, 'ready')),
          )
          .for('update');
        const byId = new Map(found.map((row) => [row.id, row]));
        const errors: FieldError[] = [];
        changes.forEach((change, index) => {
          const row = byId.get(change.id);
          const upload = change.key ? stagedByKey.get(change.key) : undefined;
          // A file replaced is named as its upload, unless given a name.
          const named = upload?.filename ?? row?.filename ?? '';
          if (!row) {
            errors.push({
              field: ['files', String(index), 'id'],
              code: 'NOT_FOUND',
              message: 'File not found',
            });
          } else if (upload && !sameKind(row.contentType, upload.contentType)) {
            errors.push({
              field: ['files', String(index), 'originalSource'],
              code: 'INVALID',
              message: isImage(row.contentType)
                ? 'Replace an image with another image'
                : `Replace it with another ${row.contentType} file`,
            });
          } else if (
            change.filename !== undefined &&
            extensionOf(change.filename) !== extensionOf(named)
          ) {
            const kept = extensionOf(named);
            errors.push({
              field: ['files', String(index), 'filename'],
              code: 'INVALID',
              message: kept
                ? `Keep its extension, ${kept}`
                : 'Give it no extension, as it has none',
            });
          }
        });
        if (new Set(ids).size !== ids.length) {
          errors.push({ field: ['files'], code: 'INVALID', message: 'Give each file once' });
        }
        if (errors.length > 0) return { outcome: fail(errors), replacedKeys: [] };
        const updated: FileRecord[] = [];
        const replacedKeys: string[] = [];
        for (const change of changes) {
          const row = byId.get(change.id)!;
          const upload = change.key ? stagedByKey.get(change.key) : undefined;
          // The upload is taken once, by whoever locks it first.
          const taken = upload
            ? await tx
                .delete(files)
                .where(
                  and(
                    eq(files.shopId, tenant.shopId),
                    eq(files.id, upload.id),
                    eq(files.status, 'staged'),
                  ),
                )
                .returning({ id: files.id })
            : [];
          if (upload && taken.length === 0) {
            throw new StagedUploadTaken();
          }
          const filename = change.filename ?? upload?.filename ?? row.filename;
          const alt = change.alt ?? row.alt;
          if (!upload && filename === row.filename && alt === row.alt) {
            updated.push(toRecord(row));
            continue;
          }
          const [saved] = await tx
            .update(files)
            .set({
              filename,
              alt,
              ...(upload && {
                key: upload.key,
                contentType: upload.contentType,
                size: upload.size,
              }),
              updatedAt: sql`now()`,
            })
            .where(and(eq(files.shopId, tenant.shopId), eq(files.id, row.id)))
            .returning();
          if (upload) replacedKeys.push(row.key);
          await appendEvent<FileUpdatedPayload>(tx, tenant.shopId, {
            type: FileEvents.FileUpdated,
            aggregateType: 'file',
            aggregateId: row.id,
            payload: {
              changed: [
                ...(upload ? ['file'] : []),
                ...(filename === row.filename ? [] : ['filename']),
                ...(alt === row.alt ? [] : ['alt']),
              ],
            },
          });
          updated.push(toRecord(saved!));
        }
        return { outcome: { ok: true, value: updated }, replacedKeys };
      })
      .catch((error: unknown): Replaced => {
        if (!(error instanceof StagedUploadTaken)) throw error;
        const taken: FieldError = { field: ['files'], code: 'INVALID', message: NOT_STAGED };
        return { outcome: fail([taken]), replacedKeys: [] };
      });
    // What storage kept of the files replaced, and the sizes made of them, go once committed.
    await this.#remove(result.replacedKeys);
    return result.outcome;
  }

  /** Deletes files, and what storage keeps of them; the IDs deleted. */
  async delete(tenant: TenantContext, ids: string[]): Promise<MutationResult<string[]>> {
    const check = new InputChecker();
    countOf(check, ['fileIds'], ids.length);
    if (!check.ok) return fail(check.errors);
    const deleted = await this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .delete(files)
        .where(and(eq(files.shopId, tenant.shopId), inArray(files.id, ids)))
        .returning({ id: files.id, key: files.key, status: files.status });
      for (const row of rows.filter((candidate) => candidate.status === 'ready')) {
        await appendEvent<FileDeletedPayload>(tx, tenant.shopId, {
          type: FileEvents.FileDeleted,
          aggregateType: 'file',
          aggregateId: row.id,
          payload: {},
        });
      }
      return rows;
    });
    const missing = ids.filter((id) => !deleted.some((row) => row.id === id));
    await this.#remove(deleted.map((row) => row.key));
    if (missing.length > 0) {
      return fail(
        ids.flatMap((id, index) =>
          missing.includes(id)
            ? [{ field: ['fileIds', String(index)], code: 'NOT_FOUND', message: 'File not found' }]
            : [],
        ),
      );
    }
    return { ok: true, value: deleted.map((row) => row.id) };
  }

  /** A URL that shows the file for an hour. */
  urlOf(file: FileRecord): string {
    return this.storage.signDownload(file.key, FILE_URL_SECONDS, { filename: file.filename });
  }

  /** What is wrong with a staged upload, if anything: not in storage, or not as staged. */
  async #problemWith(row: FileRow): Promise<string | null> {
    const stored = await this.storage.head(row.key);
    if (!stored) return NOT_UPLOADED;
    if (stored.size !== row.size) {
      return `The upload is ${stored.size} bytes, not the ${row.size} it was staged as`;
    }
    const start = await this.storage.readStart(row.key, SNIFF_BYTES);
    if (!start || !looksLike(row.contentType as FileTypeValue, start)) {
      return `The upload is not the ${row.contentType} it was staged as`;
    }
    return null;
  }

  /**
   * Removes what storage keeps under `keys`, with the sizes made of each (ADR-538); a failure
   * leaves it for the next sweep's.
   */
  async #remove(keys: string[]): Promise<void> {
    await Promise.all(
      keys.flatMap((key) => [
        this.storage.delete(key).catch(() => undefined),
        this.storage.deletePrefix(shownFilePrefixOf(key)).catch(() => undefined),
      ]),
    );
  }
}

const NOT_UPLOADED = 'Nothing has been uploaded to its URL yet';
const NOT_STAGED = 'Give the resourceUrl of an upload stagedUploadsCreate staged';

/** What replacing files came to, and the keys of what they held before (ADR-647). */
interface Replaced {
  outcome: MutationResult<FileRecord[]>;
  replacedKeys: string[];
}

/** Another request made a file of the upload first. */
class StagedUploadTaken extends Error {}

/** Whether a file of type `b` may replace one of type `a` (ADR-647): images for images. */
function sameKind(a: string, b: string): boolean {
  return isImage(a) ? isImage(b) : a === b;
}

function isImage(type: string): boolean {
  return type.startsWith('image/');
}

/**
 * Hands a staged upload of the shop's, never made a file, to another module that keeps its bytes
 * itself, as the orders module keeps a refund's receipt (ADR-242): its row goes in the caller's
 * transaction `tx`, and the caller removes what storage keeps under `key` once that commits.
 * Whether one of `size` bytes was staged there.
 */
export async function takeStagedUploadIn(
  tx: Tx,
  shopId: string,
  key: string,
  size: number,
): Promise<boolean> {
  const taken = await tx
    .delete(files)
    .where(
      and(
        eq(files.shopId, shopId),
        eq(files.key, key),
        eq(files.status, 'staged'),
        eq(files.size, size),
      ),
    )
    .returning({ id: files.id });
  return taken.length > 0;
}

/** A filename's extension, in small letters with its dot: ".pdf"; "" where it has none. */
function extensionOf(filename: string): string {
  return /\.[^./\\]{1,16}$/.exec(filename.trim())?.[0].toLowerCase() ?? '';
}

function countOf(check: InputChecker, field: string[], count: number): void {
  if (count === 0) check.addMessage(field, 'BLANK', 'Give at least one');
  if (count > FILE_LIMITS.perRequest) {
    check.addMessage(field, 'TOO_MANY', `At most ${FILE_LIMITS.perRequest} at a time`);
  }
}

function checkStaged(
  check: InputChecker,
  field: string[],
  input: StagedUploadInput,
): { filename: string; type: FileTypeValue; size: number } | null {
  const before = check.errors.length;
  const filename = check.text([...field, 'filename'], input.filename, {
    required: true,
    max: FILE_LIMITS.filename,
  });
  const type = input.mimeType.trim().toLowerCase();
  if (!isFileType(type)) {
    check.addMessage(
      [...field, 'mimeType'],
      'INVALID',
      `Upload one of ${FILE_TYPES.join(', ')}; not ${input.mimeType.slice(0, 64)}`,
    );
  }
  const size = /^\d{1,9}$/.test(input.fileSize.trim()) ? Number(input.fileSize) : NaN;
  // A video may weigh more than the rest (ADR-258).
  const most = maxUploadBytesOf(isFileType(type) ? type : 'image/jpeg');
  if (!(size >= 1 && size <= most)) {
    check.addMessage(
      [...field, 'fileSize'],
      'INVALID',
      `A file of its type is 1 byte to ${most / 1024 / 1024} MiB, given in bytes`,
    );
  }
  if (check.errors.length > before || !filename || !isFileType(type)) return null;
  return { filename, type, size };
}

/** Deletes staged uploads older than a day, some at a time; the keys storage kept them under. */
async function sweep(tx: Tx, shopId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ key: string }>(sql`
    DELETE FROM files.files
     WHERE shop_id = ${shopId}
       AND id IN (SELECT id FROM files.files
                   WHERE shop_id = ${shopId} AND status = 'staged'
                     AND created_at < now() - ${`${STAGED_HOURS} hours`}::interval
                   ORDER BY created_at
                   LIMIT ${SWEEP})
    RETURNING key`);
  return rows.map((row) => row.key);
}

export function toRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType as FileTypeValue,
    size: row.size,
    alt: row.alt,
    key: row.key,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
