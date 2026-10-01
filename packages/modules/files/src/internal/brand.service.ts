import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { FileEvents, type ShopBrandUpdatePayload } from './events.js';
import type { FileTypeValue } from './file-types.js';
import { toRecord } from './file.service.js';
import type { FileRecord } from './records.js';
import { brands, files, type FileRow } from './schema.js';

/** How long a page's link to the shop's logo works: an hour, far longer than it takes to load. */
export const LOGO_URL_SECONDS = 3600;

/** What a logo may be: an image, never a PDF. */
export const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** The shop's brand as its staff see it: its logo, or none. */
export interface BrandRecord {
  logo: FileRecord | null;
  /** Null until it is first set. */
  updatedAt: Date | null;
}

export interface BrandInput {
  /** One of the shop's files, an image; null to have none. Left as it is if absent. */
  logo?: string | null;
}

/** The shop's logo, for the pages that show it: where storage keeps it. */
export interface ShopLogo {
  key: string;
  contentType: FileTypeValue;
}

/**
 * The shop's brand (ADR-081): its logo, one of the files it uploaded, as Shopify's
 * `shop.brand.logo` is one of its images. Checkout's page shows it in place of the shop's name;
 * deleting the file takes it away.
 */
@Injectable()
export class BrandService {
  constructor(private readonly db: Database) {}

  async get(tenant: TenantContext): Promise<BrandRecord> {
    return this.db.tenant(tenant.shopId, (tx) => brandIn(tx, tenant.shopId));
  }

  /** Changes what is given; records `shop_brand.updated` if anything changed. */
  async update(tenant: TenantContext, input: BrandInput): Promise<MutationResult<BrandRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await brandIn(tx, tenant.shopId);
      if (input.logo === undefined) return { ok: true, value: before };
      const check = new InputChecker();
      let logo: FileRow | null = null;
      if (input.logo !== null) {
        [logo = null] = await tx
          .select()
          .from(files)
          .where(
            and(
              eq(files.shopId, tenant.shopId),
              eq(files.id, input.logo),
              eq(files.status, 'ready'),
            ),
          );
        if (!logo) check.addMessage(['input', 'logo'], 'NOT_FOUND', 'File not found');
        else if (!(LOGO_TYPES as readonly string[]).includes(logo.contentType)) {
          check.addMessage(
            ['input', 'logo'],
            'INVALID',
            `A logo is an image: JPEG, PNG, WebP or GIF, not ${logo.contentType}`,
          );
        }
      }
      if (!check.ok) return fail(check.errors);
      if ((before.logo?.id ?? null) === (logo?.id ?? null)) return { ok: true, value: before };
      const [saved] = await tx
        .insert(brands)
        .values({ shopId: tenant.shopId, logoFileId: logo?.id ?? null })
        .onConflictDoUpdate({
          target: brands.shopId,
          set: { logoFileId: logo?.id ?? null, updatedAt: sql`now()` },
        })
        .returning();
      await appendEvent<ShopBrandUpdatePayload>(tx, tenant.shopId, {
        type: FileEvents.ShopBrandUpdated,
        aggregateType: 'shop_brand',
        aggregateId: tenant.shopId,
        payload: { changed: ['logo'] },
      });
      return { ok: true, value: { logo: logo && toRecord(logo), updatedAt: saved!.updatedAt } };
    });
  }
}

/** The shop's logo, in the caller's transaction `tx`, for a page to show; null for none. */
export async function shopLogoOf(tx: Tx, shopId: string): Promise<ShopLogo | null> {
  const [row] = await tx
    .select({ key: files.key, contentType: files.contentType })
    .from(brands)
    .innerJoin(files, and(eq(files.shopId, brands.shopId), eq(files.id, brands.logoFileId)))
    .where(and(eq(brands.shopId, shopId), eq(files.status, 'ready')));
  return row ? { key: row.key, contentType: row.contentType as FileTypeValue } : null;
}

async function brandIn(tx: Tx, shopId: string): Promise<BrandRecord> {
  const [row] = await tx
    .select({ brand: brands, logo: files })
    .from(brands)
    .leftJoin(
      files,
      and(
        eq(files.shopId, brands.shopId),
        eq(files.id, brands.logoFileId),
        eq(files.status, 'ready'),
      ),
    )
    .where(eq(brands.shopId, shopId));
  return {
    logo: row?.logo ? toRecord(row.logo) : null,
    updatedAt: row?.brand.updatedAt ?? null,
  };
}
