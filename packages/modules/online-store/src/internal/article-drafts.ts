import {
  AiGateway,
  ARTICLE_DRAFT_LIMITS,
  briefText,
  draftArticle,
  type ArticleDraft,
  type CopyLanguage,
} from '@hatti/ai';
import {
  AiCredits,
  aiCreditsMessage,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// AI drafts of blog articles (MKT-15, ADR-801): an article's title, body, summary and search
// engine title and description, from what the shop wants it to say, in English, Urdu or Roman
// Urdu. Nothing is kept: the draft comes back to the article's form, where the shop checks it
// and saves it as any article is saved. Thirty asks a day at most, each logged with what it cost,
// and each draft given spends one of the AI credits the shop's plan includes a month (ADR-533).

export const ARTICLE_DRAFT_ASKS = {
  /** Asks a shop may make in a day: an article costs more than a product's copy. */
  perDay: 30,
} as const;

export const ARTICLE_LANGUAGES: readonly CopyLanguage[] = ['en', 'ur', 'roman_ur'];

/** Whether a shop may ask for AI drafts of articles, and how many it asked for today. */
export interface ArticleDraftingRecord {
  available: boolean;
  usedToday: number;
  limitPerDay: number;
  /** The plan's AI credits left this month, and how many it includes; null where uncounted. */
  creditsLeft: number | null;
  creditsPerMonth: number | null;
}

export interface ArticleDraftInput {
  language: CopyLanguage;
  topic: string;
  notes?: string | null;
  /** The blog it is for, whose title the draft keeps to. */
  blogId?: string | null;
}

@Injectable()
export class ArticleDraftService {
  constructor(
    private readonly db: Database,
    /** The AI gateway, where the host configured one (ADR-463): without it, no drafts. */
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
    /** The AI credits of the shop's plan (ADR-533); without them, drafts are not counted. */
    @Optional() @Inject(AiCredits) private readonly credits?: AiCredits | null,
  ) {}

  /** Whether the shop may ask for drafts, and how many it has asked for in the last day. */
  async drafting(tenant: TenantContext, now: Date = new Date()): Promise<ArticleDraftingRecord> {
    const usedToday = await this.db.tenant(tenant.shopId, (tx) =>
      draftsSince(tx, tenant.shopId, now),
    );
    const balance = await this.credits?.balanceOf(tenant.shopId, now);
    return {
      available: Boolean(this.ai),
      usedToday,
      limitPerDay: ARTICLE_DRAFT_ASKS.perDay,
      creditsLeft: balance?.left ?? null,
      creditsPerMonth: balance?.perMonth ?? null,
    };
  }

  /** A draft of an article from what the shop wants it to say, never kept. */
  async draft(
    tenant: TenantContext,
    input: ArticleDraftInput,
    now: Date = new Date(),
  ): Promise<MutationResult<ArticleDraft>> {
    const ai = this.ai;
    if (!ai) return failOne(['base'], 'UNAVAILABLE', "AI drafts aren't set up here");
    const topic = input.topic.trim();
    if (!topic) {
      return failOne(['input', 'topic'], 'BLANK', 'Say what the article is about');
    }
    if (topic.length > ARTICLE_DRAFT_LIMITS.topic) {
      return failOne(
        ['input', 'topic'],
        'TOO_LONG',
        `Say what it is about in ${ARTICLE_DRAFT_LIMITS.topic} characters at most`,
      );
    }
    const read = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = input.blogId
        ? await tx.execute<{ title: string }>(sql`
            SELECT title FROM online_store.blogs
             WHERE shop_id = ${tenant.shopId} AND id = ${input.blogId}`)
        : { rows: [] };
      return {
        blog: rows[0] ?? null,
        used: await draftsSince(tx, tenant.shopId, now),
        shopName: (await shopProfile(tx, tenant.shopId)).name,
      };
    });
    if (input.blogId && !read.blog) {
      return failOne(['input', 'blogId'], 'NOT_FOUND', 'No such blog');
    }
    const brief = { topic, notes: input.notes ?? null, blogTitle: read.blog?.title ?? null };
    if (briefText(brief).length > ARTICLE_DRAFT_LIMITS.brief) {
      return failOne(
        ['input', 'notes'],
        'TOO_LONG',
        `The AI writes from ${ARTICLE_DRAFT_LIMITS.brief.toLocaleString('en')} characters at ` +
          'most: say less of what it must say',
      );
    }
    if (read.used >= ARTICLE_DRAFT_ASKS.perDay) {
      return failOne(
        ['base'],
        'TOO_MANY',
        `A shop may ask for ${ARTICLE_DRAFT_ASKS.perDay} AI drafts of articles a day: try again ` +
          'tomorrow',
      );
    }
    const balance = await this.credits?.balanceOf(tenant.shopId, now);
    if (balance && balance.left <= 0) {
      return failOne(['base'], 'TOO_MANY', aiCreditsMessage(balance));
    }
    const result = await draftArticle(ai, {
      shopName: read.shopName,
      language: input.language,
      brief,
    });
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO online_store.article_drafts
          (shop_id, blog_id, language, outcome, input_tokens, output_tokens, created_at)
        VALUES (${tenant.shopId}, ${input.blogId ?? null}, ${input.language},
                ${result.ok ? 'drafted' : result.reason}, ${usage.inputTokens},
                ${usage.outputTokens}, ${now.toISOString()})`),
    );
    if (result.ok) await this.credits?.spend(tenant.shopId, 'article', now);
    if (!result.ok) {
      return failOne(
        ['base'],
        'UNAVAILABLE',
        result.reason === 'refused'
          ? 'The AI would not write this article: write it yourself'
          : 'The AI could not write this just now: try again in a minute',
      );
    }
    return { ok: true, value: result.value };
  }
}

/** How many drafts of articles the shop asked for in the day before `now`. */
async function draftsSince(tx: Tx, shopId: string, now: Date): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM online_store.article_drafts
     WHERE shop_id = ${shopId}
       AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
  return rows[0]!.count;
}
