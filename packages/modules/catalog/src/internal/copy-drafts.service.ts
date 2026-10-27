import {
  AiGateway,
  PRODUCT_COPY_LIMITS,
  draftProductCopy,
  factsText,
  type AiImage,
  type CopyLanguage,
  type ProductCopy,
  type ProductFacts,
} from '@hatti/ai';
import { AiCredits, aiCreditsMessage, shopProfile, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { cropImage, modelImage } from '@hatti/images';
import { ObjectStorage } from '@hatti/storage';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { cleanImageKey } from './images.js';
import { failOne, type MutationResult } from './input-checker.js';
import { loadProduct } from './product-store.js';

// AI drafts of products' copy (CAT-20, ADR-471): a product's title, description and search engine
// title and description, from what the shop says of it, in English, Urdu or Roman Urdu. Nothing
// is kept: the draft comes back to the product's form, where the shop checks it and saves it as
// any product is saved. A hundred asks a day at most, each logged with what it cost, and each
// draft given spends one of the AI credits the shop's plan includes a month (ADR-533). The AI may
// look at the product's photos too (APP-02, ADR-507), for a listing drafted from a picture.

export const COPY_DRAFT_LIMITS = {
  /** Asks a shop may make in a day. */
  perDay: 100,
  /** The product's ready photos the AI looks at, the first in its order. */
  photos: 3,
} as const;

export const COPY_LANGUAGES: readonly CopyLanguage[] = ['en', 'ur', 'roman_ur'];

/** Whether a shop may ask for AI drafts of products' copy, and how many it asked for today. */
export interface CopyDraftingRecord {
  available: boolean;
  usedToday: number;
  limitPerDay: number;
  /** The plan's AI credits left this month, and how many it includes; null where uncounted. */
  creditsLeft: number | null;
  creditsPerMonth: number | null;
}

export interface CopyDraftInput extends ProductFacts {
  language: CopyLanguage;
  /** The product it is for, once there is one. */
  productId?: string | null;
  /** Whether the AI looks at the product's first ready photos too (APP-02). */
  usePhotos?: boolean;
}

@Injectable()
export class CopyDraftService {
  constructor(
    private readonly db: Database,
    /** The AI gateway, where the host configured one (ADR-463): without it, no drafts. */
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
    /** Where products' images are kept, to show the AI their photos. */
    @Optional() @Inject(ObjectStorage) private readonly storage?: ObjectStorage | null,
    /** The AI credits of the shop's plan (ADR-533); without them, drafts are not counted. */
    @Optional() @Inject(AiCredits) private readonly credits?: AiCredits | null,
  ) {}

  /** Whether the shop may ask for drafts, and how many it has asked for in the last day. */
  async drafting(tenant: TenantContext, now: Date = new Date()): Promise<CopyDraftingRecord> {
    const usedToday = await this.db.tenant(tenant.shopId, (tx) =>
      draftsSince(tx, tenant.shopId, now),
    );
    const balance = await this.credits?.balanceOf(tenant.shopId, now);
    return {
      available: Boolean(this.ai),
      usedToday,
      limitPerDay: COPY_DRAFT_LIMITS.perDay,
      creditsLeft: balance?.left ?? null,
      creditsPerMonth: balance?.perMonth ?? null,
    };
  }

  /** A draft of the product's copy from what the shop says of it, never kept. */
  async draft(
    tenant: TenantContext,
    input: CopyDraftInput,
    now: Date = new Date(),
  ): Promise<MutationResult<ProductCopy>> {
    const ai = this.ai;
    if (!ai) return failOne(['base'], 'UNAVAILABLE', "AI drafts aren't set up here");
    const facts = factsText(input);
    if (input.usePhotos && !input.productId) {
      return failOne(['input', 'productId'], 'BLANK', 'Save the product with its photos first');
    }
    const images = input.usePhotos ? await this.photosOf(tenant, input.productId!) : [];
    if (images === null) return failOne(['input', 'productId'], 'NOT_FOUND', 'No such product');
    if (input.usePhotos && images.length === 0) {
      return failOne(
        ['input', 'usePhotos'],
        'INVALID',
        'The product has no photo ready yet: wait for it, or say what it is',
      );
    }
    if (!input.title?.trim() && !input.notes?.trim() && images.length === 0) {
      return failOne(
        ['input', 'title'],
        'BLANK',
        'Give the product a title, or say what it is, for the AI to write from',
      );
    }
    if (facts.length > PRODUCT_COPY_LIMITS.facts) {
      return failOne(
        ['input', 'notes'],
        'TOO_LONG',
        `The AI writes from ${PRODUCT_COPY_LIMITS.facts.toLocaleString('en')} characters at ` +
          'most: say less of the product',
      );
    }
    const read = await this.db.tenant(tenant.shopId, async (tx) => ({
      used: await draftsSince(tx, tenant.shopId, now),
      shopName: (await shopProfile(tx, tenant.shopId)).name,
    }));
    if (read.used >= COPY_DRAFT_LIMITS.perDay) {
      return failOne(
        ['base'],
        'TOO_MANY',
        `A shop may ask for ${COPY_DRAFT_LIMITS.perDay} AI drafts of products a day: try again ` +
          'tomorrow',
      );
    }
    const balance = await this.credits?.balanceOf(tenant.shopId, now);
    if (balance && balance.left <= 0) {
      return failOne(['base'], 'TOO_MANY', aiCreditsMessage(balance));
    }
    const result = await draftProductCopy(ai, {
      shopName: read.shopName,
      language: input.language,
      facts: input,
      ...(images.length > 0 && { images }),
    });
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO catalog.copy_drafts
          (shop_id, product_id, language, outcome, input_tokens, output_tokens, created_at)
        VALUES (${tenant.shopId}, ${input.productId ?? null}, ${input.language},
                ${result.ok ? 'drafted' : result.reason}, ${usage.inputTokens},
                ${usage.outputTokens}, ${now.toISOString()})`),
    );
    if (result.ok) await this.credits?.spend(tenant.shopId, 'product_copy', now);
    if (!result.ok) {
      return failOne(
        ['base'],
        'UNAVAILABLE',
        result.reason === 'refused'
          ? 'The AI would not write about this product: write it yourself'
          : 'The AI could not write this just now: try again in a minute',
      );
    }
    return { ok: true, value: result.value };
  }

  /**
   * The product's first ready photos, as the shop cropped them, made small enough for the AI;
   * null where the shop has no such product.
   */
  private async photosOf(tenant: TenantContext, productId: string): Promise<AiImage[] | null> {
    const product = await this.db.tenant(tenant.shopId, (tx) =>
      loadProduct(tx, tenant.shopId, productId),
    );
    if (!product) return null;
    if (!this.storage) return [];
    const ready = product.media
      .filter(
        (media) =>
          media.mediaType === 'image' && media.status === 'ready' && media.imageFormat !== null,
      )
      .slice(0, COPY_DRAFT_LIMITS.photos);
    const images: AiImage[] = [];
    for (const media of ready) {
      const clean = await this.storage.read(
        cleanImageKey(tenant.shopId, media.id, media.imageFormat!),
      );
      if (!clean) continue;
      const shown = media.crop
        ? await cropImage(clean.body, media.crop, media.imageFormat!)
        : clean.body;
      images.push({ mediaType: 'image/jpeg', data: await modelImage(shown) });
    }
    return images;
  }
}

/** How many drafts the shop asked for in the day before `now`. */
async function draftsSince(tx: Tx, shopId: string, now: Date): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM catalog.copy_drafts
     WHERE shop_id = ${shopId}
       AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
  return rows[0]!.count;
}
