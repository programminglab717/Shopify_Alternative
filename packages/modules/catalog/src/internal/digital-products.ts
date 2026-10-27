import { createHash } from 'node:crypto';
import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { ObjectStorage } from '@hatti/storage';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Digital products (CAT-13, ADR-813): a product sold as files to download or licence keys,
// needing no delivery. Its files are kept privately, apart from the files the shop's pages show,
// and reach a buyer by a link of their own once the order is paid; its keys are a pool the shop
// fills, each kept encrypted and given once, to one unit of an order's line.

export const DigitalProductEvents = {
  /** A product was made digital, changed, or made physical again. */
  Updated: 'digital_product.updated',
} as const;

export const DIGITAL_LIMITS = {
  downloadLimit: { default: 5, min: 1, max: 50 },
  linkDays: { default: 30, min: 1, max: 365 },
  /** Files a product sells, and how much each may weigh: 2 GiB. */
  files: 20,
  fileSize: 2_147_483_648,
  filename: 255,
  /** Keys added at once, and how long one may be. */
  keysAtOnce: 1_000,
  key: 500,
} as const;

/** How long a staged upload's URL works, and a download's: an hour, and five minutes. */
const UPLOAD_SECONDS = 3_600;
const DOWNLOAD_SECONDS = 300;

/** A product's file to download, as the Admin API shows it. */
export interface DigitalFileRecord {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  status: 'staged' | 'ready';
  createdAt: Date;
}

/** A licence key of a product, as the Admin API shows it: never the key itself. */
export interface LicenceKeyRecord {
  id: string;
  /** Its last four characters, to tell it. */
  hint: string;
  issuedAt: Date | null;
  orderId: string | null;
}

/** A digital product: how it reaches the buyer. */
export interface DigitalProductRecord {
  downloadLimit: number;
  linkDays: number;
  licenceKeys: boolean;
  files: DigitalFileRecord[];
  /** Its keys not yet given, and given. */
  keysLeft: number;
  keysIssued: number;
}

/** A file staged to upload: where, and how. */
export interface DigitalFileStaged {
  file: DigitalFileRecord;
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface DigitalProductInput {
  downloadLimit?: number | null;
  linkDays?: number | null;
  licenceKeys?: boolean | null;
}

type DigitalRow = { download_limit: number; link_days: number; licence_keys: boolean };

/** The associated data a product's keys are sealed with: they open for that product alone. */
const keyContext = (shopId: string, productId: string) => `licence_key:${shopId}:${productId}`;

const digestOf = (key: string) => createHash('sha256').update(key).digest();

/** A filename as storage keeps it under its key: letters, digits, dots, hyphens. */
const keyName = (filename: string) =>
  filename
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'file';

@Injectable()
export class DigitalProductService {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(ObjectStorage) private readonly storage?: ObjectStorage | null,
    /** Seals licence keys (ADR-813); without it, none are kept. */
    @Optional() @Inject(SecretBox) private readonly box?: SecretBox | null,
  ) {}

  /** Each of `productIds` that is digital, and how. */
  async of(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, DigitalProductRecord>> {
    return this.db.tenant(tenant.shopId, (tx) => digitalIn(tx, tenant.shopId, productIds));
  }

  /**
   * Makes a product digital, or changes how it reaches the buyer: what is left out stays, or is
   * Hatti's default. A gift card is not digital: its card is what it sells (ADR-451).
   */
  async set(
    tenant: TenantContext,
    productId: string,
    input: DigitalProductInput,
  ): Promise<MutationResult<DigitalProductRecord>> {
    const check = new InputChecker();
    const downloadLimit = check.integer(['input', 'downloadLimit'], input.downloadLimit, {
      min: DIGITAL_LIMITS.downloadLimit.min,
      max: DIGITAL_LIMITS.downloadLimit.max,
    });
    const linkDays = check.integer(['input', 'linkDays'], input.linkDays, {
      min: DIGITAL_LIMITS.linkDays.min,
      max: DIGITAL_LIMITS.linkDays.max,
    });
    if (!check.ok) return { ok: false, errors: check.errors };
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      const { rows: product } = await tx.execute<{ gift_card: boolean }>(sql`
        SELECT gift_card FROM catalog.products WHERE shop_id = ${shopId} AND id = ${productId}
           FOR UPDATE`);
      if (!product[0]) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      if (product[0].gift_card) {
        return failOne(
          ['productId'],
          'INVALID',
          'A gift card is sold as its card: it cannot be a digital product too',
        );
      }
      const before = await rowIn(tx, shopId, productId);
      const next = {
        download_limit:
          downloadLimit ?? before?.download_limit ?? DIGITAL_LIMITS.downloadLimit.default,
        link_days: linkDays ?? before?.link_days ?? DIGITAL_LIMITS.linkDays.default,
        licence_keys: input.licenceKeys ?? before?.licence_keys ?? false,
      };
      await tx.execute(sql`
        INSERT INTO catalog.digital_products
               (shop_id, product_id, download_limit, link_days, licence_keys)
        VALUES (${shopId}, ${productId}, ${next.download_limit}, ${next.link_days},
                ${next.licence_keys})
        ON CONFLICT (shop_id, product_id) DO UPDATE
          SET download_limit = EXCLUDED.download_limit, link_days = EXCLUDED.link_days,
              licence_keys = EXCLUDED.licence_keys, updated_at = now()`);
      if (!before) await updated(tx, shopId, productId, true);
      return { ok: true, value: (await digitalIn(tx, shopId, [productId])).get(productId)! };
    });
  }

  /**
   * Makes a digital product physical again: its files go, from storage too, and its keys not
   * given. Whether it was digital.
   */
  async unset(tenant: TenantContext, productId: string): Promise<boolean> {
    const shopId = tenant.shopId;
    const removed = await this.db.tenant(shopId, async (tx) => {
      const { rows: files } = await tx.execute<{ key: string }>(sql`
        SELECT key FROM catalog.digital_files
         WHERE shop_id = ${shopId} AND product_id = ${productId}`);
      const { rows } = await tx.execute(sql`
        DELETE FROM catalog.digital_products
         WHERE shop_id = ${shopId} AND product_id = ${productId}
        RETURNING product_id`);
      if (rows.length === 0) return null;
      await updated(tx, shopId, productId, false);
      return files.map((file) => file.key);
    });
    if (!removed) return false;
    await Promise.all(removed.map((key) => this.storage?.delete(key).catch(() => undefined)));
    return true;
  }

  /**
   * Stages the upload of a file a digital product sells: where to upload it, for an hour. It is
   * the product's once {@link fileCreate} finds it there.
   */
  async fileStage(
    tenant: TenantContext,
    productId: string,
    input: { filename: string; contentType: string; size: number },
  ): Promise<MutationResult<DigitalFileStaged>> {
    const storage = this.storage;
    if (!storage) return failOne(['input'], 'UNAVAILABLE', 'Files are not kept here');
    const check = new InputChecker();
    const filename = check.text(['input', 'filename'], input.filename, {
      max: DIGITAL_LIMITS.filename,
      required: true,
    });
    const contentType = input.contentType.trim().toLowerCase();
    if (!/^[a-z]+\/[a-z0-9.+-]{1,100}$/.test(contentType)) {
      check.addMessage(['input', 'contentType'], 'INVALID', 'Say what kind of file it is');
    }
    if (!Number.isInteger(input.size) || input.size < 1 || input.size > DIGITAL_LIMITS.fileSize) {
      check.addMessage(['input', 'size'], 'INVALID', 'A file weighs 2 GB at most');
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      if (!(await rowIn(tx, shopId, productId))) {
        return failOne(['productId'], 'NOT_FOUND', 'The product is not digital');
      }
      const { rows: count } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM catalog.digital_files
         WHERE shop_id = ${shopId} AND product_id = ${productId}`);
      if (count[0]!.count >= DIGITAL_LIMITS.files) {
        return failOne(
          ['productId'],
          'TOO_MANY',
          `A product sells ${DIGITAL_LIMITS.files} files at most`,
        );
      }
      const id = newId();
      const key = `shops/${shopId}/digital/${id}/${keyName(filename!)}`;
      const { rows } = await tx.execute<FileRow>(sql`
        INSERT INTO catalog.digital_files (shop_id, id, product_id, key, filename, content_type, size)
        VALUES (${shopId}, ${id}, ${productId}, ${key}, ${filename}, ${contentType}, ${input.size})
        RETURNING id, filename, content_type, size, status, created_at`);
      const upload = storage.signUpload(
        key,
        { contentType, contentLength: input.size },
        UPLOAD_SECONDS,
      );
      return { ok: true, value: { file: toFile(rows[0]!), ...upload } };
    });
  }

  /** The staged file `fileId`, once storage has it as staged: ready to sell. */
  async fileCreate(
    tenant: TenantContext,
    fileId: string,
  ): Promise<MutationResult<DigitalFileRecord>> {
    const storage = this.storage;
    if (!storage) return failOne(['id'], 'UNAVAILABLE', 'Files are not kept here');
    const shopId = tenant.shopId;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<FileRow & { key: string }>(sql`
        SELECT id, key, filename, content_type, size, status, created_at FROM catalog.digital_files
         WHERE shop_id = ${shopId} AND id = ${fileId}`),
    );
    const row = rows[0];
    if (!row) return failOne(['id'], 'NOT_FOUND', 'No such file');
    if (row.status === 'ready') return { ok: true, value: toFile(row) };
    const stored = await storage.head(row.key);
    if (!stored) return failOne(['id'], 'INVALID', 'Nothing has been uploaded to its URL yet');
    if (stored.size !== Number(row.size)) {
      return failOne(
        ['id'],
        'INVALID',
        `The upload is ${stored.size} bytes, not the ${row.size} it was staged as`,
      );
    }
    const { rows: ready } = await this.db.tenant(shopId, (tx) =>
      tx.execute<FileRow>(sql`
        UPDATE catalog.digital_files SET status = 'ready'
         WHERE shop_id = ${shopId} AND id = ${fileId}
        RETURNING id, filename, content_type, size, status, created_at`),
    );
    return { ok: true, value: toFile(ready[0] ?? row) };
  }

  /** Removes a digital product's file, from storage too: whether there was one. */
  async fileDelete(tenant: TenantContext, fileId: string): Promise<boolean> {
    const shopId = tenant.shopId;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ key: string }>(sql`
        DELETE FROM catalog.digital_files WHERE shop_id = ${shopId} AND id = ${fileId}
        RETURNING key`),
    );
    if (!rows[0]) return false;
    await this.storage?.delete(rows[0].key).catch(() => undefined);
    return true;
  }

  /**
   * Adds licence keys to a digital product's pool, each kept sealed: those it has already are
   * left out. How many were added, and how many it had.
   */
  async keysAdd(
    tenant: TenantContext,
    productId: string,
    keys: readonly string[],
  ): Promise<MutationResult<{ added: number; already: number }>> {
    const box = this.box;
    if (!box) return failOne(['keys'], 'UNAVAILABLE', 'Licence keys are not kept here');
    const typed = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
    if (typed.length === 0) return failOne(['keys'], 'BLANK', 'Give one key at least');
    if (typed.length > DIGITAL_LIMITS.keysAtOnce) {
      return failOne(
        ['keys'],
        'TOO_MANY',
        `Add ${DIGITAL_LIMITS.keysAtOnce.toLocaleString('en')} keys at most at once`,
      );
    }
    const long = typed.findIndex((key) => key.length > DIGITAL_LIMITS.key);
    if (long >= 0) {
      return failOne(
        ['keys', String(long)],
        'TOO_LONG',
        `A key is ${DIGITAL_LIMITS.key} characters at most`,
      );
    }
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      if (!(await rowIn(tx, shopId, productId))) {
        return failOne(['productId'], 'NOT_FOUND', 'The product is not digital');
      }
      let added = 0;
      for (const key of typed) {
        const { rows } = await tx.execute(sql`
          INSERT INTO catalog.licence_keys (shop_id, product_id, sealed, hint, digest)
          VALUES (${shopId}, ${productId}, ${box.encrypt(key, keyContext(shopId, productId))},
                  ${key.slice(-4)}, ${digestOf(key)})
          ON CONFLICT (shop_id, product_id, digest) DO NOTHING
          RETURNING id`);
        added += rows.length;
      }
      return { ok: true, value: { added, already: typed.length - added } };
    });
  }

  /** A digital product's keys, the latest added first: never the keys themselves. */
  async keys(tenant: TenantContext, productId: string, first = 50): Promise<LicenceKeyRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{
        id: string;
        hint: string;
        issued_at: string | Date | null;
        order_id: string | null;
      }>(sql`
        SELECT id, hint, issued_at, order_id FROM catalog.licence_keys
         WHERE shop_id = ${tenant.shopId} AND product_id = ${productId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${Math.min(Math.max(first, 1), 250)}`),
    );
    return rows.map((row) => ({
      id: row.id,
      hint: row.hint,
      issuedAt: row.issued_at === null ? null : toDate(row.issued_at),
      orderId: row.order_id,
    }));
  }

  /** Removes a key not yet given: whether there was one. */
  async keyDelete(tenant: TenantContext, keyId: string): Promise<boolean> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        DELETE FROM catalog.licence_keys
         WHERE shop_id = ${tenant.shopId} AND id = ${keyId} AND issued_at IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /** A URL that downloads the file `key` names for five minutes, as `filename`. */
  downloadUrl(key: string, filename: string): string | null {
    return this.storage?.signDownload(key, DOWNLOAD_SECONDS, { filename }) ?? null;
  }
}

type FileRow = {
  id: string;
  filename: string;
  content_type: string;
  size: string | number;
  status: 'staged' | 'ready';
  created_at: string | Date;
};

const toFile = (row: FileRow): DigitalFileRecord => ({
  id: row.id,
  filename: row.filename,
  contentType: row.content_type,
  size: Number(row.size),
  status: row.status,
  createdAt: toDate(row.created_at),
});

async function rowIn(tx: Tx, shopId: string, productId: string): Promise<DigitalRow | undefined> {
  const { rows } = await tx.execute<DigitalRow>(sql`
    SELECT download_limit, link_days, licence_keys FROM catalog.digital_products
     WHERE shop_id = ${shopId} AND product_id = ${productId}`);
  return rows[0];
}

async function updated(tx: Tx, shopId: string, productId: string, digital: boolean) {
  await appendEvent(tx, shopId, {
    type: DigitalProductEvents.Updated,
    aggregateType: 'product',
    aggregateId: productId,
    payload: { digital },
  });
}

/** Each of `productIds` that is digital, and how, in the caller's transaction. */
export async function digitalIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, DigitalProductRecord>> {
  if (productIds.length === 0) return new Map();
  const ids = sql.param([...new Set(productIds)]);
  const { rows } = await tx.execute<
    DigitalRow & { product_id: string; keys_left: number; keys_issued: number }
  >(sql`
    SELECT d.product_id, d.download_limit, d.link_days, d.licence_keys,
           (SELECT count(*)::int FROM catalog.licence_keys k
             WHERE k.shop_id = d.shop_id AND k.product_id = d.product_id
               AND k.issued_at IS NULL) AS keys_left,
           (SELECT count(*)::int FROM catalog.licence_keys k
             WHERE k.shop_id = d.shop_id AND k.product_id = d.product_id
               AND k.issued_at IS NOT NULL) AS keys_issued
      FROM catalog.digital_products d
     WHERE d.shop_id = ${shopId} AND d.product_id = ANY(${ids}::uuid[])`);
  const { rows: files } = await tx.execute<FileRow & { product_id: string }>(sql`
    SELECT product_id, id, filename, content_type, size, status, created_at
      FROM catalog.digital_files
     WHERE shop_id = ${shopId} AND product_id = ANY(${ids}::uuid[])
     ORDER BY created_at, id`);
  return new Map(
    rows.map((row) => [
      row.product_id,
      {
        downloadLimit: row.download_limit,
        linkDays: row.link_days,
        licenceKeys: row.licence_keys,
        files: files.filter((file) => file.product_id === row.product_id).map(toFile),
        keysLeft: row.keys_left,
        keysIssued: row.keys_issued,
      },
    ]),
  );
}

/** Which of `productIds` are digital, needing no delivery (ADR-813). */
export async function digitalProductIdsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ product_id: string }>(sql`
    SELECT product_id FROM catalog.digital_products
     WHERE shop_id = ${shopId} AND product_id = ANY(${sql.param([...new Set(productIds)])}::uuid[])`);
  return new Set(rows.map((row) => row.product_id));
}

/** A digital product's files ready to download, with where storage keeps them. */
export async function digitalFilesIn(
  tx: Tx,
  shopId: string,
  productId: string,
): Promise<{ id: string; key: string; filename: string; size: number }[]> {
  const { rows } = await tx.execute<{
    id: string;
    key: string;
    filename: string;
    size: string;
  }>(sql`
    SELECT id, key, filename, size::text FROM catalog.digital_files
     WHERE shop_id = ${shopId} AND product_id = ${productId} AND status = 'ready'
     ORDER BY created_at, id`);
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

/**
 * Gives unit `unit.lineUnit` of an order's line one of the product's keys, in the caller's
 * transaction, once: the key it was given, opened with `box`; null where none are left.
 */
export async function issueLicenceKeyIn(
  tx: Tx,
  shopId: string,
  productId: string,
  unit: { orderId: string; lineItemId: string; lineUnit: number },
  box: SecretBox,
  at: Date = new Date(),
): Promise<string | null> {
  const { rows: given } = await tx.execute<{ sealed: string }>(sql`
    SELECT sealed FROM catalog.licence_keys
     WHERE shop_id = ${shopId} AND line_item_id = ${unit.lineItemId}
       AND line_unit = ${unit.lineUnit}`);
  let sealed = given[0]?.sealed;
  if (!sealed) {
    const { rows } = await tx.execute<{ sealed: string }>(sql`
      UPDATE catalog.licence_keys SET order_id = ${unit.orderId}, line_item_id = ${unit.lineItemId},
             line_unit = ${unit.lineUnit}, issued_at = ${at.toISOString()}
       WHERE shop_id = ${shopId} AND id = (
               SELECT id FROM catalog.licence_keys
                WHERE shop_id = ${shopId} AND product_id = ${productId} AND issued_at IS NULL
                ORDER BY created_at, id LIMIT 1
                  FOR UPDATE SKIP LOCKED)
      RETURNING sealed`);
    sealed = rows[0]?.sealed;
  }
  return sealed ? box.decrypt(sealed, keyContext(shopId, productId)).toString('utf8') : null;
}
