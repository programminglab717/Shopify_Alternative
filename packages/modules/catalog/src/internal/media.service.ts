import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { CONTENT_TYPES, MAX_ASPECT_RATIO, cropImage } from '@hatti/images';
import { ObjectStorage } from '@hatti/storage';
import { Injectable, Optional } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { cleanImageKey, cropNameOf } from './images.js';
import { InputChecker, LIMITS, fail, failOne, type MutationResult } from './input-checker.js';
import { loadForUpdate, loadProduct, productChanged } from './product-store.js';
import type { FocalPointRecord, MediaCropRecord, MediaRecord, ProductRecord } from './records.js';
import { productMedia } from './schema.js';

export interface MediaCreateInput {
  /**
   * Where the image is: an https URL to fetch it from, or the resource URL of a file the shop
   * uploaded through a staged upload (ADR-079).
   */
  originalSource: string;
  alt?: string | null;
}

export interface MediaUpdateInput {
  id: string;
  alt?: string | null;
  /**
   * The part of a ready image shown, in its clean copy's pixels (ADR-257); null for the whole
   * image again.
   */
  crop?: MediaCropRecord | null;
  /**
   * What matters in the image, in percent of the image shown, across and down; null for none. A
   * new crop shows another image, so it clears the focal point unless one comes with it.
   */
  focalPoint?: FocalPointRecord | null;
}

/** The fewest pixels a side of a crop may have. */
export const CROP_MIN_SIDE = 16;

export interface MediaMove {
  id: string;
  /** 1 is first. */
  newPosition: number;
}

/** Writes media positions 1..n in the given order, in one statement. */
async function writePositions(tx: Tx, shopId: string, mediaIds: readonly string[]): Promise<void> {
  if (mediaIds.length === 0) return;
  await tx.execute(sql`
    UPDATE catalog.product_media m
       SET position = u.position, updated_at = now()
      FROM unnest(${sql.param(mediaIds)}::uuid[]) WITH ORDINALITY AS u(id, position)
     WHERE m.shop_id = ${shopId} AND m.id = u.id AND m.position <> u.position`);
}

/**
 * Product images. A new image is due to the worker, which reads it from the file the shop
 * uploaded, or fetches it from its URL, checks it and keeps a clean copy, and marks it ready, or
 * failed, saying why (ADR-158). Until then the storefront shows an image by URL from its source.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly db: Database,
    @Optional() private readonly storage?: ObjectStorage,
  ) {}

  async create(
    tenant: TenantContext,
    productId: string,
    inputs: MediaCreateInput[],
  ): Promise<MutationResult<{ product: ProductRecord; mediaIds: string[] }>> {
    const check = new InputChecker();
    if (inputs.length === 0) check.add(['media'], 'BLANK', 'must include at least one');
    const values = inputs.map((input, index) => {
      const upload = this.#uploadOf(tenant.shopId, input.originalSource);
      return {
        sourceUrl:
          upload?.url ??
          check.httpsUrl(['media', String(index), 'originalSource'], input.originalSource),
        sourceKey: upload?.key ?? null,
        alt: check.text(['media', String(index), 'alt'], input.alt, { max: LIMITS.alt }) ?? '',
      };
    });
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      if (product.media.length + inputs.length > LIMITS.media) {
        return failOne(['media'], 'TOO_MANY', `A product can have at most ${LIMITS.media} media`);
      }
      let position = Math.max(0, ...product.media.map((media) => media.position));
      const rows = values.map((value) => ({
        shopId: tenant.shopId,
        id: newId(),
        productId,
        sourceUrl: value.sourceUrl!,
        sourceKey: value.sourceKey,
        alt: value.alt,
        position: ++position,
      }));
      await tx.insert(productMedia).values(rows);
      await productChanged(tx, tenant, productId, ['media']);
      return {
        ok: true,
        value: {
          product: (await loadProduct(tx, tenant.shopId, productId))!,
          mediaIds: rows.map((row) => row.id),
        },
      };
    });
  }

  /**
   * Changes media's alt text, and an image's crop and focal point (ADR-257). A crop's clean copy
   * is made from the whole image's, and kept beside it, before the crop is recorded: every size
   * and format the image is shown in is made from it.
   */
  async update(
    tenant: TenantContext,
    productId: string,
    inputs: MediaUpdateInput[],
  ): Promise<MutationResult<ProductRecord>> {
    const check = new InputChecker();
    if (inputs.length === 0) check.add(['media'], 'BLANK', 'must include at least one');
    const alts = inputs.map((input, index) =>
      input.alt === undefined
        ? undefined
        : (check.text(['media', String(index), 'alt'], input.alt, { max: LIMITS.alt }) ?? ''),
    );
    const focalPoints = inputs.map((input, index) =>
      input.focalPoint
        ? focalPointOf(check, ['media', String(index), 'focalPoint'], input.focalPoint)
        : input.focalPoint,
    );
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const known = new Map(product.media.map((media) => [media.id, media]));
      inputs.forEach((input, index) => {
        if (!known.has(input.id)) {
          check.addMessage(
            ['media', String(index), 'id'],
            'NOT_FOUND',
            'The product has no such media',
          );
        }
      });
      if (!check.ok) return fail(check.errors);
      // Every crop checked against its image before any is made.
      const crops = inputs.map((input, index) =>
        input.crop === undefined
          ? undefined
          : cropOf(check, ['media', String(index), 'crop'], known.get(input.id)!, input.crop),
      );
      if (!check.ok) return fail(check.errors);
      for (const [index, input] of inputs.entries()) {
        const media = known.get(input.id)!;
        const changes: SQL[] = [];
        const alt = alts[index];
        if (alt !== undefined) changes.push(sql`alt = ${alt}`);
        const crop = crops[index];
        if (crop !== undefined && !sameCrop(crop, media.crop)) {
          if (crop && !(await this.#keepCrop(tenant.shopId, media, crop))) {
            return failOne(
              ['media', String(index), 'crop'],
              'INVALID',
              'The image could not be cropped just now: try again',
            );
          }
          changes.push(sql`crop_left = ${crop?.left ?? null}, crop_top = ${crop?.top ?? null},
                           crop_width = ${crop?.width ?? null},
                           crop_height = ${crop?.height ?? null}`);
          // Its focal point was of the image shown before.
          if (focalPoints[index] === undefined) changes.push(sql`focal_x = NULL, focal_y = NULL`);
        }
        const focalPoint = focalPoints[index];
        if (focalPoint !== undefined) {
          changes.push(sql`focal_x = ${focalPoint?.x ?? null}, focal_y = ${focalPoint?.y ?? null}`);
        }
        if (changes.length === 0) continue;
        await tx.execute(sql`
          UPDATE catalog.product_media SET ${sql.join(changes, sql`, `)}, updated_at = now()
           WHERE shop_id = ${tenant.shopId} AND id = ${input.id}`);
      }
      await productChanged(tx, tenant, productId, ['media']);
      return { ok: true, value: (await loadProduct(tx, tenant.shopId, productId))! };
    });
  }

  /** Deletes media; variants showing them show none. */
  async delete(
    tenant: TenantContext,
    productId: string,
    mediaIds: string[],
  ): Promise<MutationResult<{ product: ProductRecord; deletedIds: string[] }>> {
    if (mediaIds.length === 0) {
      return failOne(['mediaIds'], 'BLANK', 'Media ids must include at least one');
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const check = new InputChecker();
      const known = new Set(product.media.map((media) => media.id));
      mediaIds.forEach((id, index) => {
        if (!known.has(id)) {
          check.addMessage(
            ['mediaIds', String(index)],
            'NOT_FOUND',
            'The product has no such media',
          );
        }
      });
      if (!check.ok) return fail(check.errors);
      const removed = new Set(mediaIds);
      await tx.execute(sql`
        DELETE FROM catalog.product_media
         WHERE shop_id = ${tenant.shopId} AND id = ANY(${sql.param([...removed])}::uuid[])`);
      await writePositions(
        tx,
        tenant.shopId,
        product.media.filter((media) => !removed.has(media.id)).map((media) => media.id),
      );
      await productChanged(tx, tenant, productId, ['media']);
      return {
        ok: true,
        value: {
          product: (await loadProduct(tx, tenant.shopId, productId))!,
          deletedIds: [...removed],
        },
      };
    });
  }

  /** Moves media, one move after another, like dragging them in the admin. */
  async reorder(
    tenant: TenantContext,
    productId: string,
    moves: MediaMove[],
  ): Promise<MutationResult<ProductRecord>> {
    if (moves.length === 0) return failOne(['moves'], 'BLANK', 'Moves must include at least one');
    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const check = new InputChecker();
      const order = product.media.map((media) => media.id);
      moves.forEach((move, index) => {
        const from = order.indexOf(move.id);
        if (from === -1) {
          check.addMessage(
            ['moves', String(index), 'id'],
            'NOT_FOUND',
            'The product has no such media',
          );
          return;
        }
        if (
          !Number.isInteger(move.newPosition) ||
          move.newPosition < 1 ||
          move.newPosition > order.length
        ) {
          check.add(
            ['moves', String(index), 'newPosition'],
            'INVALID',
            `must be from 1 to ${order.length}`,
          );
          return;
        }
        order.splice(from, 1);
        order.splice(move.newPosition - 1, 0, move.id);
      });
      if (!check.ok) return fail(check.errors);
      await writePositions(tx, tenant.shopId, order);
      await productChanged(tx, tenant, productId, ['media']);
      return { ok: true, value: (await loadProduct(tx, tenant.shopId, productId))! };
    });
  }

  /**
   * Makes and keeps the clean copy of `crop` of a ready image, from its whole clean copy, unless
   * one was kept before. Whether it is kept.
   */
  async #keepCrop(shopId: string, media: MediaRecord, crop: MediaCropRecord): Promise<boolean> {
    const format = media.imageFormat;
    if (!this.storage || format === null) return false;
    const key = cleanImageKey(shopId, media.id, format, cropNameOf(crop));
    if (await this.storage.head(key)) return true;
    const whole = await this.storage.read(cleanImageKey(shopId, media.id, format));
    if (!whole) return false;
    await this.storage.put(key, await cropImage(whole.body, crop, format), CONTENT_TYPES[format]);
    return true;
  }

  /**
   * A file the shop uploaded, named by its staged upload's resource URL (ADR-079): its key in
   * storage and its location; null for anything else, such as an image's URL.
   */
  #uploadOf(shopId: string, source: string): { key: string; url: string } | null {
    const url = source.trim();
    const key = url.length <= 2048 ? this.storage?.keyOf(url) : null;
    return key?.startsWith(`shops/${shopId}/files/`) ? { key, url } : null;
  }
}

/**
 * The crop asked of `media`, checked against it: a part of a ready image, at least
 * {@link CROP_MIN_SIDE} pixels a side, one side at most 20 times the other; null for the whole
 * image, as a crop of all of it is.
 */
function cropOf(
  check: InputChecker,
  field: string[],
  media: MediaRecord,
  crop: MediaCropRecord | null,
): MediaCropRecord | null {
  if (crop === null) return null;
  const { width, height } = media;
  if (media.status !== 'ready' || width === null || height === null) {
    check.addMessage(field, 'INVALID', 'An image is cropped once it is ready');
    return null;
  }
  const { left, top } = crop;
  const sides = [crop.width, crop.height];
  if (![left, top, ...sides].every(Number.isInteger) || left < 0 || top < 0) {
    check.addMessage(field, 'INVALID', 'Give the crop in whole pixels from the top left');
    return null;
  }
  if (sides.some((side) => side < CROP_MIN_SIDE)) {
    check.addMessage(field, 'INVALID', `A crop is at least ${CROP_MIN_SIDE} pixels a side`);
    return null;
  }
  if (left + crop.width > width || top + crop.height > height) {
    check.addMessage(field, 'INVALID', `Crop within the image's ${width} × ${height} pixels`);
    return null;
  }
  if (Math.max(...sides) > MAX_ASPECT_RATIO * Math.min(...sides)) {
    check.addMessage(field, 'INVALID', 'One side of a crop may be at most 20 times the other');
    return null;
  }
  if (left === 0 && top === 0 && crop.width === width && crop.height === height) return null;
  return { left, top, width: crop.width, height: crop.height };
}

/** A focal point in percent, across and down, to the hundredth. */
function focalPointOf(
  check: InputChecker,
  field: string[],
  point: FocalPointRecord,
): FocalPointRecord | null {
  const inside = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
  if (!inside(point.x) || !inside(point.y)) {
    check.addMessage(field, 'INVALID', 'Give the focal point in percent, from 0 to 100');
    return null;
  }
  return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
}

function sameCrop(a: MediaCropRecord | null, b: MediaCropRecord | null): boolean {
  return a === null || b === null
    ? a === b
    : a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
