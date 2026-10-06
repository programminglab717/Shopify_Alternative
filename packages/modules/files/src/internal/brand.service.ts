import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { FileEvents, type ShopBrandUpdatePayload } from './events.js';
import type { FileTypeValue } from './file-types.js';
import { toRecord } from './file.service.js';
import type { FileRecord } from './records.js';
import { brands, files, type FileRow } from './schema.js';

/** How long a page's link to the shop's logo works: an hour, far longer than it takes to load. */
export const LOGO_URL_SECONDS = 3600;

/** What a logo may be: an image, never a PDF. */
export const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/**
 * The images a shop's brand has, as Shopify's `shop.brand` has them: its logo, and its square logo
 * for the places that show a square (ADR-205).
 */
export const BRAND_IMAGES = ['logo', 'squareLogo'] as const;
export type BrandImageValue = (typeof BRAND_IMAGES)[number];

/** The shop's brand as its staff see it: its logo and square logo, or none. */
export interface BrandRecord {
  logo: FileRecord | null;
  squareLogo: FileRecord | null;
  /** Null until it is first set. */
  updatedAt: Date | null;
}

export interface BrandInput {
  /** One of the shop's files, an image; null to have none. Left as it is if absent. */
  logo?: string | null;
  /** As the logo: one of the shop's files, an image, which the shop has square. */
  squareLogo?: string | null;
}

/** The shop's logo, for the pages that show it: where storage keeps it. */
export interface ShopLogo {
  /** Its file's: another is another image. */
  id: string;
  key: string;
  contentType: FileTypeValue;
}

/**
 * The shop's brand (ADR-081): its logo, one of the files it uploaded, as Shopify's
 * `shop.brand.logo` is one of its images, and its square logo, as `shop.brand.square_logo`
 * (ADR-205). Checkout's page shows the logo in place of the shop's name, and the link page the
 * square logo, else the logo; deleting a file takes it away.
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
      const given = BRAND_IMAGES.filter((name) => input[name] !== undefined);
      const check = new InputChecker();
      const chosen = new Map<BrandImageValue, FileRow | null>();
      for (const name of given) {
        const id = input[name]!;
        let file: FileRow | null = null;
        if (id !== null) {
          [file = null] = await tx
            .select()
            .from(files)
            .where(
              and(eq(files.shopId, tenant.shopId), eq(files.id, id), eq(files.status, 'ready')),
            );
          if (!file) check.addMessage(['input', name], 'NOT_FOUND', 'File not found');
          else if (!(LOGO_TYPES as readonly string[]).includes(file.contentType)) {
            check.addMessage(
              ['input', name],
              'INVALID',
              `A logo is an image: JPEG, PNG, WebP or GIF, not ${file.contentType}`,
            );
          }
        }
        chosen.set(name, file);
      }
      if (!check.ok) return fail(check.errors);
      const changed = given.filter(
        (name) => (before[name]?.id ?? null) !== (chosen.get(name)?.id ?? null),
      );
      if (changed.length === 0) return { ok: true, value: before };
      const set = {
        ...(changed.includes('logo') && { logoFileId: chosen.get('logo')?.id ?? null }),
        ...(changed.includes('squareLogo') && {
          squareLogoFileId: chosen.get('squareLogo')?.id ?? null,
        }),
      };
      const [saved] = await tx
        .insert(brands)
        .values({ shopId: tenant.shopId, ...set })
        .onConflictDoUpdate({ target: brands.shopId, set: { ...set, updatedAt: sql`now()` } })
        .returning();
      await appendEvent<ShopBrandUpdatePayload>(tx, tenant.shopId, {
        type: FileEvents.ShopBrandUpdated,
        aggregateType: 'shop_brand',
        aggregateId: tenant.shopId,
        payload: { changed },
      });
      const now = (name: BrandImageValue): FileRecord | null => {
        if (!changed.includes(name)) return before[name];
        const file = chosen.get(name);
        return file ? toRecord(file) : null;
      };
      return {
        ok: true,
        value: { logo: now('logo'), squareLogo: now('squareLogo'), updatedAt: saved!.updatedAt },
      };
    });
  }
}

/**
 * The shop's logo, or its square logo (ADR-205), in the caller's transaction `tx`, for a page to
 * show; null for none.
 */
export async function shopLogoOf(
  tx: Tx,
  shopId: string,
  which: BrandImageValue = 'logo',
): Promise<ShopLogo | null> {
  const fileId = which === 'logo' ? brands.logoFileId : brands.squareLogoFileId;
  const [row] = await tx
    .select({ id: files.id, key: files.key, contentType: files.contentType })
    .from(brands)
    .innerJoin(files, and(eq(files.shopId, brands.shopId), eq(files.id, fileId)))
    .where(and(eq(brands.shopId, shopId), eq(files.status, 'ready')));
  return row ? { id: row.id, key: row.key, contentType: row.contentType as FileTypeValue } : null;
}

/** One of the shop's files that a page can show as an image, as a logo is. */
export interface ShopImage {
  id: string;
  key: string;
  contentType: FileTypeValue;
  /** What the shop wrote of it; empty for nothing. */
  alt: string;
}

/**
 * Of the files `ids` names, those of the shop's that a page can show as images, uploaded and of
 * a logo's types, by their IDs, in the caller's transaction `tx`: for another module's own image,
 * as an article's is (ADR-213).
 */
export async function readyImagesIn(
  tx: Tx,
  shopId: string,
  ids: readonly string[],
): Promise<Map<string, ShopImage>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: files.id, key: files.key, contentType: files.contentType, alt: files.alt })
    .from(files)
    .where(
      and(
        eq(files.shopId, shopId),
        inArray(files.id, [...new Set(ids)]),
        eq(files.status, 'ready'),
        inArray(files.contentType, [...LOGO_TYPES]),
      ),
    );
  return new Map(
    rows.map((row) => [row.id, { ...row, contentType: row.contentType as FileTypeValue }]),
  );
}

async function brandIn(tx: Tx, shopId: string): Promise<BrandRecord> {
  const square = alias(files, 'square_logo');
  const [row] = await tx
    .select({ brand: brands, logo: files, squareLogo: square })
    .from(brands)
    .leftJoin(
      files,
      and(
        eq(files.shopId, brands.shopId),
        eq(files.id, brands.logoFileId),
        eq(files.status, 'ready'),
      ),
    )
    .leftJoin(
      square,
      and(
        eq(square.shopId, brands.shopId),
        eq(square.id, brands.squareLogoFileId),
        eq(square.status, 'ready'),
      ),
    )
    .where(eq(brands.shopId, shopId));
  return {
    logo: row?.logo ? toRecord(row.logo) : null,
    squareLogo: row?.squareLogo ? toRecord(row.squareLogo) : null,
    updatedAt: row?.brand.updatedAt ?? null,
  };
}
