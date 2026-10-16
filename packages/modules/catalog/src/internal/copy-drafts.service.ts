import {
  AiGateway,
  PRODUCT_COPY_LIMITS,
  draftProductCopy,
  factsText,
  type CopyLanguage,
  type ProductCopy,
  type ProductFacts,
} from '@hatti/ai';
import { shopProfile, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { failOne, type MutationResult } from './input-checker.js';

// AI drafts of products' copy (CAT-20, ADR-471): a product's title, description and search engine
// title and description, from what the shop says of it, in English, Urdu or Roman Urdu. Nothing
// is kept: the draft comes back to the product's form, where the shop checks it and saves it as
// any product is saved. A hundred asks a day at most, each logged with what it cost.

export const COPY_DRAFT_LIMITS = {
  /** Asks a shop may make in a day. */
  perDay: 100,
} as const;

export const COPY_LANGUAGES: readonly CopyLanguage[] = ['en', 'ur', 'roman_ur'];

/** Whether a shop may ask for AI drafts of products' copy, and how many it asked for today. */
export interface CopyDraftingRecord {
  available: boolean;
  usedToday: number;
  limitPerDay: number;
}

export interface CopyDraftInput extends ProductFacts {
  language: CopyLanguage;
  /** The product it is for, once there is one. */
  productId?: string | null;
}

@Injectable()
export class CopyDraftService {
  constructor(
    private readonly db: Database,
    /** The AI gateway, where the host configured one (ADR-463): without it, no drafts. */
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
  ) {}

  /** Whether the shop may ask for drafts, and how many it has asked for in the last day. */
  async drafting(tenant: TenantContext, now: Date = new Date()): Promise<CopyDraftingRecord> {
    const usedToday = await this.db.tenant(tenant.shopId, (tx) =>
      draftsSince(tx, tenant.shopId, now),
    );
    return { available: Boolean(this.ai), usedToday, limitPerDay: COPY_DRAFT_LIMITS.perDay };
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
    if (!input.title?.trim() && !input.notes?.trim()) {
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
    const result = await draftProductCopy(ai, {
      shopName: read.shopName,
      language: input.language,
      facts: input,
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
}

/** How many drafts the shop asked for in the day before `now`. */
async function draftsSince(tx: Tx, shopId: string, now: Date): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM catalog.copy_drafts
     WHERE shop_id = ${shopId}
       AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
  return rows[0]!.count;
}
