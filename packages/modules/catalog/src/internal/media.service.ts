import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { InputChecker, LIMITS, fail, failOne, type MutationResult } from './input-checker.js';
import { loadForUpdate, loadProduct, productChanged } from './product-store.js';
import type { ProductRecord } from './records.js';
import { productMedia } from './schema.js';

export interface MediaCreateInput {
  /** Where to fetch the file from: an https URL. */
  originalSource: string;
  alt?: string | null;
}

export interface MediaUpdateInput {
  id: string;
  alt?: string | null;
}

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
 * Product images. A new image points at its original source until the media worker (not built
 * yet) fetches, checks and resizes it and marks it ready.
 */
@Injectable()
export class MediaService {
  constructor(private readonly db: Database) {}

  async create(
    tenant: TenantContext,
    productId: string,
    inputs: MediaCreateInput[],
  ): Promise<MutationResult<{ product: ProductRecord; mediaIds: string[] }>> {
    const check = new InputChecker();
    if (inputs.length === 0) check.add(['media'], 'BLANK', 'must include at least one');
    const values = inputs.map((input, index) => ({
      sourceUrl: check.httpsUrl(['media', String(index), 'originalSource'], input.originalSource),
      alt: check.text(['media', String(index), 'alt'], input.alt, { max: LIMITS.alt }) ?? '',
    }));
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
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const known = new Set(product.media.map((media) => media.id));
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
      for (const [index, input] of inputs.entries()) {
        const alt = alts[index];
        if (alt === undefined) continue;
        await tx.execute(sql`
          UPDATE catalog.product_media SET alt = ${alt}, updated_at = now()
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
}
