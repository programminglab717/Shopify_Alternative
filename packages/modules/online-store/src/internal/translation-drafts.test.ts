import 'reflect-metadata';
import { AiGateway } from '@hatti/ai';
import { AiCredits, type AiCreditBalance, type AiCreditUse } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';
import { TRANSLATION_DRAFT_LIMITS, TranslationService } from './translation.service.js';

const server = testDatabaseServer();

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

const codesOf = (result: Parameters<typeof errorsOf>[0]) =>
  errorsOf(result).map(([field, code]) => [field, code]);

/** A fake provider: each prompt kept, each answer given in turn. */
function provider() {
  const prompts: string[] = [];
  const answers: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    prompts.push(body.messages[0]!.content);
    const answer = answers.shift() ?? { content: [], stop_reason: 'refusal' };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const answer = (translations: { key: string; value: string }[]) =>
    answers.push({
      content: [{ type: 'tool_use', name: 'give_translations', input: { translations } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 900, output_tokens: 210 },
    });
  return { fetch, prompts, answer };
}

describe.skipIf(!server)('AI drafts of translations (CAT-07, ADR-463)', () => {
  let f: OnlineStoreFixture;
  let fake: ReturnType<typeof provider>;
  let drafts: TranslationService;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM online_store.translation_drafts');
    fake = provider();
    // The fixture's service, with a gateway over the fake provider.
    drafts = new TranslationService(
      f.db,
      f.products,
      f.collections,
      f.pages,
      f.blogs,
      f.articles,
      f.menus,
      new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch: fake.fetch }),
    );
  });

  const logged = async () =>
    (
      await f.admin.query<{ keys: string[]; outcome: string; input_tokens: number }>(
        'SELECT keys, outcome, input_tokens FROM online_store.translation_drafts ORDER BY created_at',
      )
    ).rows;

  it("drafts a product's fields in Urdu, each with its words' digest, to keep once checked", async () => {
    const lawn = unwrap(
      await f.products.create(f.a, {
        title: 'Lawn Suit',
        description: 'Soft lawn.\n\nThree pieces.',
        productType: 'Suits',
      }),
    );
    fake.answer([
      { key: 'title', value: 'لان سوٹ' },
      { key: 'body_html', value: '<p>نرم لان۔</p><p>تین پیس۔</p>' },
      { key: 'product_type', value: 'سوٹ' },
    ]);
    const drafted = unwrap(await drafts.draft(f.a, 'product', lawn.id, { locale: 'ur' }));
    const own = (await f.translations.resource(f.a, 'product', lawn.id))!.content;
    const digest = (key: string) => own.find((field) => field.key === key)!.digest;
    expect(drafted).toEqual([
      { key: 'title', value: 'لان سوٹ', digest: digest('title') },
      { key: 'body_html', value: '<p>نرم لان۔</p><p>تین پیس۔</p>', digest: digest('body_html') },
      { key: 'product_type', value: 'سوٹ', digest: digest('product_type') },
    ]);
    // The shop's name and words went to the model; nothing was kept as a translation.
    expect(fake.prompts[0]).toContain('The shop is called "A"');
    expect(fake.prompts[0]).toContain('>Lawn Suit</field>');
    expect((await f.translations.resource(f.a, 'product', lawn.id))!.translations).toEqual([]);
    expect(await logged()).toEqual([
      { keys: ['title', 'body_html', 'product_type'], outcome: 'drafted', input_tokens: 900 },
    ]);
    // Kept as the shop checked them: its review.
    unwrap(
      await f.translations.register(
        f.a,
        'product',
        lawn.id,
        drafted.map((draft) => ({
          locale: 'ur',
          key: draft.key,
          value: draft.value,
          translatableContentDigest: draft.digest,
        })),
      ),
    );

    // Only the fields asked for; a refusal says so and is counted.
    expect(
      codesOf(await drafts.draft(f.a, 'product', lawn.id, { locale: 'ur', keys: ['title'] })),
    ).toEqual([['base', 'UNAVAILABLE']]);
    expect(fake.prompts[1]).not.toContain('body_html');
    expect((await logged()).map((row) => row.outcome)).toEqual(['drafted', 'refused']);
    expect(await drafts.drafting(f.a)).toEqual({
      available: true,
      usedToday: 2,
      limitPerDay: TRANSLATION_DRAFT_LIMITS.perDay,
      creditsLeft: null,
      creditsPerMonth: null,
    });
  });

  it("refuses without a gateway, past the day's drafts, and for what cannot be drafted", async () => {
    const page = unwrap(
      await f.pages.create(f.a, { title: 'About us', body: '<p>Since 1990</p>' }),
    );
    const plain = f.translations;
    expect(codesOf(await plain.draft(f.a, 'page', page.id, { locale: 'ur' }))).toEqual([
      ['base', 'UNAVAILABLE'],
    ]);
    expect((await plain.drafting(f.a)).available).toBe(false);
    expect(codesOf(await drafts.draft(f.a, 'page', page.id, { locale: 'fr' }))).toEqual([
      ['locale', 'INVALID'],
    ]);
    expect(
      codesOf(await drafts.draft(f.a, 'page', page.id, { locale: 'ur', keys: ['product_type'] })),
    ).toEqual([['keys', 'INVALID']]);
    expect(codesOf(await drafts.draft(f.a, 'page', newId(), { locale: 'ur' }))).toEqual([
      ['resourceId', 'NOT_FOUND'],
    ]);
    // Another shop's page is not this shop's.
    expect(codesOf(await drafts.draft(f.b, 'page', page.id, { locale: 'ur' }))).toEqual([
      ['resourceId', 'NOT_FOUND'],
    ]);
    // A draft that would not be kept as a translation is left out.
    fake.answer([
      { key: 'title', value: 'ہمارے بارے میں '.repeat(40) },
      { key: 'body_html', value: '<p>1990 سے</p><script>alert(1)</script>' },
    ]);
    expect(unwrap(await drafts.draft(f.a, 'page', page.id, { locale: 'ur' }))).toEqual([
      expect.objectContaining({ key: 'body_html', value: '<p>1990 سے</p>' }),
    ]);
    await f.admin.query(
      `INSERT INTO online_store.translation_drafts (shop_id, resource_id, locale, keys, outcome)
       SELECT $1, $2, 'ur', ARRAY['title'], 'drafted' FROM generate_series(1, $3)`,
      [f.a.shopId, page.id, TRANSLATION_DRAFT_LIMITS.perDay],
    );
    expect(codesOf(await drafts.draft(f.a, 'page', page.id, { locale: 'ur' }))).toEqual([
      ['base', 'TOO_MANY'],
    ]);
    expect(fake.prompts).toHaveLength(1);
  });

  it("spends one of the plan's AI credits on each draft given, and drafts none past them (ADR-533)", async () => {
    const page = unwrap(
      await f.pages.create(f.a, { title: 'About us', body: '<p>Since 1990</p>' }),
    );
    const credits = new Credits(1);
    const counted = new TranslationService(
      f.db,
      f.products,
      f.collections,
      f.pages,
      f.blogs,
      f.articles,
      f.menus,
      new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch: fake.fetch }),
      credits,
    );
    expect(await counted.drafting(f.a)).toMatchObject({ creditsLeft: 1, creditsPerMonth: 10 });
    fake.answer([{ key: 'title', value: 'ہمارے بارے میں' }]);
    expect(
      unwrap(await counted.draft(f.a, 'page', page.id, { locale: 'ur', keys: ['title'] })),
    ).toHaveLength(1);
    expect(credits.spent).toEqual(['translation']);
    const refused = await counted.draft(f.a, 'page', page.id, { locale: 'ur' });
    expect(refused.ok || refused.errors).toEqual([
      {
        field: ['base'],
        code: 'TOO_MANY',
        message:
          "The Free plan includes 10 AI credits a month, and this month's are used: they come back on the 1st, or choose a bigger plan for more",
      },
    ]);
    expect(fake.prompts).toHaveLength(1);
  });
});
