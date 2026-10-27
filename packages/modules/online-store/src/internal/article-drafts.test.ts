import 'reflect-metadata';
import { AiGateway } from '@hatti/ai';
import { AiCredits, type AiCreditBalance, type AiCreditUse } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARTICLE_DRAFT_ASKS, ArticleDraftService } from './article-drafts.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

const codesOf = (result: Parameters<typeof errorsOf>[0]) =>
  errorsOf(result).map(([field, code]) => [field, code]);

/** A plan's AI credits, as billing keeps them (ADR-533): `left` of ten this month. */
class Credits extends AiCredits {
  readonly spent: AiCreditUse[] = [];

  constructor(private left: number) {
    super();
  }

  async balanceOf(): Promise<AiCreditBalance> {
    return {
      perMonth: 10,
      used: 10 - this.left,
      bought: 0,
      left: this.left,
      plan: 'Free',
      renewsAt: new Date('2026-11-01T00:00:00+05:00'),
    };
  }

  async spend(_shopId: string, use: AiCreditUse): Promise<void> {
    this.spent.push(use);
    this.left -= 1;
  }
}

/** A fake provider: each prompt kept, each answer given in turn, a refusal once they run out. */
function provider() {
  const prompts: string[] = [];
  const answers: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    prompts.push(body.messages[0]!.content);
    const answer = answers.shift() ?? { content: [], stop_reason: 'refusal' };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const answer = () =>
    answers.push({
      content: [
        {
          type: 'tool_use',
          name: 'give_article',
          input: {
            title: 'Caring for lawn in summer',
            body_html: '<p>Lawn breathes.</p><h2>Washing</h2><p>Cold water.</p>',
            summary_html: '<p>Keep lawn fresh.</p>',
            seo_title: 'Caring for lawn in summer',
            seo_description: 'How to wash and iron lawn.',
          },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 400, output_tokens: 800 },
    });
  return { fetch, prompts, answer };
}

describe.skipIf(!server)('AI drafts of articles (MKT-15, ADR-801)', () => {
  let f: OnlineStoreFixture;
  let fake: ReturnType<typeof provider>;
  let credits: Credits;
  let drafts: ArticleDraftService;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM online_store.article_drafts');
    fake = provider();
    credits = new Credits(2);
    drafts = new ArticleDraftService(
      f.db,
      new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch: fake.fetch }),
      credits,
    );
  });

  const logged = async () =>
    (
      await f.admin.query<{ language: string; outcome: string; output_tokens: number }>(
        'SELECT language, outcome, output_tokens FROM online_store.article_drafts ORDER BY created_at',
      )
    ).rows;

  it("drafts an article from the shop's brief for its blog, spending a credit, never keeping it", async () => {
    const blog = unwrap(await f.blogs.create(f.a, { title: 'Style notes' }));
    fake.answer();
    const drafted = unwrap(
      await drafts.draft(f.a, {
        language: 'roman_ur',
        topic: ' Caring for lawn in summer ',
        notes: 'Our lawn is 100% cotton.',
        blogId: blog.id,
      }),
    );
    expect(drafted).toEqual({
      title: 'Caring for lawn in summer',
      bodyHtml: '<p>Lawn breathes.</p><h2>Washing</h2><p>Cold water.</p>',
      summaryHtml: '<p>Keep lawn fresh.</p>',
      seoTitle: 'Caring for lawn in summer',
      seoDescription: 'How to wash and iron lawn.',
    });
    expect(fake.prompts[0]).toContain('Blog: Style notes\nTopic: Caring for lawn in summer');
    expect(fake.prompts[0]).toContain('It must say: Our lawn is 100% cotton.');
    expect(credits.spent).toEqual(['article']);
    expect(await logged()).toEqual([
      { language: 'roman_ur', outcome: 'drafted', output_tokens: 800 },
    ]);
    // Nothing of it is kept: the shop's blog has no article.
    const { rows } = await f.admin.query('SELECT 1 FROM online_store.articles');
    expect(rows).toEqual([]);

    // A refusal spends no credit, and is logged; with no credit left, no ask is made.
    expect(codesOf(await drafts.draft(f.a, { language: 'en', topic: 'Eid' }))).toEqual([
      ['base', 'UNAVAILABLE'],
    ]);
    expect(credits.spent).toEqual(['article']);
    credits = new Credits(0);
    const spent = new ArticleDraftService(
      f.db,
      new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch: fake.fetch }),
      credits,
    );
    expect(codesOf(await spent.draft(f.a, { language: 'en', topic: 'Eid' }))).toEqual([
      ['base', 'TOO_MANY'],
    ]);
    expect(fake.prompts).toHaveLength(2);
    const drafting = await drafts.drafting(f.a);
    expect(drafting).toMatchObject({
      available: true,
      usedToday: 2,
      limitPerDay: ARTICLE_DRAFT_ASKS.perDay,
    });
  });

  it('refuses no topic, too much said, another shop’s blog, too many a day, and no AI at all', async () => {
    expect(codesOf(await drafts.draft(f.a, { language: 'en', topic: '  ' }))).toEqual([
      ['input.topic', 'BLANK'],
    ]);
    expect(
      codesOf(await drafts.draft(f.a, { language: 'en', topic: 'Eid', notes: 'x'.repeat(4_000) })),
    ).toEqual([['input.notes', 'TOO_LONG']]);
    const theirs = unwrap(await f.blogs.create(f.b, { title: 'Theirs' }));
    expect(
      codesOf(await drafts.draft(f.a, { language: 'en', topic: 'Eid', blogId: theirs.id })),
    ).toEqual([['input.blogId', 'NOT_FOUND']]);
    await f.admin.query(
      `INSERT INTO online_store.article_drafts (shop_id, language, outcome)
       SELECT $1, 'en', 'drafted' FROM generate_series(1, $2)`,
      [f.a.shopId, ARTICLE_DRAFT_ASKS.perDay],
    );
    expect(codesOf(await drafts.draft(f.a, { language: 'en', topic: 'Eid' }))).toEqual([
      ['base', 'TOO_MANY'],
    ]);
    expect(fake.prompts).toEqual([]);
    const none = new ArticleDraftService(f.db, null, credits);
    expect(codesOf(await none.draft(f.a, { language: 'en', topic: 'Eid' }))).toEqual([
      ['base', 'UNAVAILABLE'],
    ]);
    expect((await none.drafting(f.a)).available).toBe(false);
  });
});
