import 'reflect-metadata';
import { AiGateway } from '@hatti/ai';
import {
  AiCredits,
  type AiCreditBalance,
  type AiCreditUse,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COPY_DRAFT_LIMITS, CopyDraftService } from './copy-drafts.service.js';

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

const server = testDatabaseServer();

const codes = <T>(result: MutationResult<T>) =>
  result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.code]);

/** A fake provider: each prompt kept, each answer given in turn; a refusal once they run out. */
function provider() {
  const prompts: string[] = [];
  const answers: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    prompts.push(body.messages[0]!.content);
    const answer = answers.shift() ?? { content: [], stop_reason: 'refusal' };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const answer = (input: Record<string, string>) =>
    answers.push({
      content: [{ type: 'tool_use', name: 'give_product_copy', input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 400, output_tokens: 300 },
    });
  return { fetch, prompts, answer };
}

describe.skipIf(!server)("AI drafts of products' copy (CAT-20, ADR-471)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  const tenant: TenantContext = {
    shopId: newId(),
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products']),
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'copy-drafts-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [tenant.shopId]);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("drafts a product's copy in Urdu from what the shop says, logged, never kept", async () => {
    const fake = provider();
    const drafts = new CopyDraftService(
      db,
      new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch: fake.fetch }),
    );
    expect(await drafts.drafting(tenant)).toEqual({
      available: true,
      usedToday: 0,
      limitPerDay: COPY_DRAFT_LIMITS.perDay,
      creditsLeft: null,
      creditsPerMonth: null,
    });
    // Something to write from.
    expect(codes(await drafts.draft(tenant, { language: 'ur', title: ' ', notes: '' }))).toEqual([
      ['input.title', 'BLANK'],
    ]);

    fake.answer({
      title: 'پرنٹڈ لان سوٹ',
      description_html: '<p>گرمیوں کے لیے لان۔</p>',
      seo_title: 'پرنٹڈ لان سوٹ',
      seo_description: 'زری کا پرنٹڈ لان سوٹ۔',
    });
    const drafted = await drafts.draft(tenant, {
      language: 'ur',
      title: 'Printed lawn suit',
      productType: 'Unstitched',
      options: [{ name: 'Colour', values: ['Mint'] }],
      notes: 'Shirt 3m lawn',
    });
    expect(drafted).toEqual({
      ok: true,
      value: {
        title: 'پرنٹڈ لان سوٹ',
        descriptionHtml: '<p>گرمیوں کے لیے لان۔</p>',
        seoTitle: 'پرنٹڈ لان سوٹ',
        seoDescription: 'زری کا پرنٹڈ لان سوٹ۔',
      },
    });
    expect(fake.prompts[0]).toContain('The shop is called "Zari".');
    expect(fake.prompts[0]).toContain('Colour: Mint');

    // A refusal says so, and is counted.
    expect(codes(await drafts.draft(tenant, { language: 'en', title: 'Kurta' }))).toEqual([
      ['base', 'UNAVAILABLE'],
    ]);
    const { rows } = await admin.query<{ language: string; outcome: string; input_tokens: number }>(
      'SELECT language, outcome, input_tokens FROM catalog.copy_drafts ORDER BY created_at',
    );
    expect(rows).toEqual([
      { language: 'ur', outcome: 'drafted', input_tokens: 400 },
      { language: 'en', outcome: 'refused', input_tokens: 0 },
    ]);
    expect((await drafts.drafting(tenant)).usedToday).toBe(2);

    // A hundred a day.
    await admin.query(
      `INSERT INTO catalog.copy_drafts (shop_id, language, outcome)
       SELECT $1, 'en', 'drafted' FROM generate_series(1, $2)`,
      [tenant.shopId, COPY_DRAFT_LIMITS.perDay - 2],
    );
    expect(codes(await drafts.draft(tenant, { language: 'en', title: 'Kurta' }))).toEqual([
      ['base', 'TOO_MANY'],
    ]);
  });

  it("spends one of the plan's AI credits on each draft given, and drafts none past them (ADR-533)", async () => {
    await admin.query('DELETE FROM catalog.copy_drafts WHERE shop_id = $1', [tenant.shopId]);
    const fake = provider();
    const credits = new Credits(1);
    const drafts = new CopyDraftService(
      db,
      new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch: fake.fetch }),
      null,
      credits,
    );
    expect(await drafts.drafting(tenant)).toMatchObject({ creditsLeft: 1, creditsPerMonth: 10 });
    // A refusal spends nothing.
    expect(codes(await drafts.draft(tenant, { language: 'en', title: 'Kurta' }))).toEqual([
      ['base', 'UNAVAILABLE'],
    ]);
    expect(credits.spent).toEqual([]);
    fake.answer({
      title: 'Kurta',
      description_html: '<p>Cotton.</p>',
      seo_title: 'Kurta',
      seo_description: 'A cotton kurta.',
    });
    expect((await drafts.draft(tenant, { language: 'en', title: 'Kurta' })).ok).toBe(true);
    expect(credits.spent).toEqual(['product_copy']);
    const refused = await drafts.draft(tenant, { language: 'en', title: 'Kurta' });
    expect(refused.ok || refused.errors).toEqual([
      {
        field: ['base'],
        code: 'TOO_MANY',
        message:
          "The Free plan includes 10 AI credits a month, and this month's are used: they come back on the 1st, or choose a bigger plan for more",
      },
    ]);
    // Refused before asking the AI.
    expect(fake.prompts).toHaveLength(2);
  });

  it('says AI drafts are not set up without a gateway', async () => {
    const drafts = new CopyDraftService(db, null);
    expect((await drafts.drafting(tenant)).available).toBe(false);
    expect(codes(await drafts.draft(tenant, { language: 'en', title: 'Kurta' }))).toEqual([
      ['base', 'UNAVAILABLE'],
    ]);
  });
});
