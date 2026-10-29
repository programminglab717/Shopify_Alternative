import 'reflect-metadata';
import { InventoryReportService } from '@hatti/inventory/public';
import { VariantService } from '@hatti/catalog/public';
import { AiGateway } from '@hatti/ai';
import { AiCredits, type AiCreditBalance, type AiCreditUse } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomReportService } from './custom-reports.js';
import { REPORT_QUESTION_DAILY, ReportQuestionService } from './report-questions.js';
import { SalesReportService } from './sales-report.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

/** A plan's AI credits, each spend kept. */
class Credits extends AiCredits {
  left = 10;
  readonly spent: AiCreditUse[] = [];
  balanceOf(): Promise<AiCreditBalance> {
    return Promise.resolve({
      perMonth: 10,
      used: 10 - this.left,
      bought: 0,
      left: this.left,
      plan: 'Free',
      renewsAt: new Date('2026-11-01T00:00:00+05:00'),
    });
  }
  spend(_shopId: string, use: AiCreditUse) {
    this.spent.push(use);
    this.left -= 1;
    return Promise.resolve();
  }
}

/** A provider answering each question through the report tool, as `answer` says. */
function gatewayAnswering(answer: (question: string) => unknown) {
  const asked: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    const question = /<question>\n([\s\S]*)\n<\/question>/.exec(body.messages[0]!.content)![1]!;
    asked.push(question);
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'choose_report', input: answer(question) }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 300, output_tokens: 40 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { gateway: new AiGateway({ apiKey: 'sk-test', model: 'model', fetch }), asked };
}

describe.skipIf(!server)("Questions of the shop's numbers (ANL-08, ADR-844)", () => {
  let f: OrdersFixture;
  let reports: CustomReportService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    reports = new CustomReportService(
      f.db,
      new SalesReportService(f.db),
      new InventoryReportService(f.db, new VariantService(f.db)),
    );
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  it('runs the report the question was read into, the question alone sent', async () => {
    const order = await f.order(f.a, [kurta, kurta]);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [
      order.id,
      '2026-10-20T10:00:00Z',
    ]);
    const { gateway, asked } = gatewayAnswering(() => ({
      answerable: true,
      breakdown: 'day',
      // A line of true profit, on a plan without it, is left out of the choices and the answer.
      columns: ['orders', 'total_sales', 'profit'],
      period: 'last_7_days',
    }));
    const credits = new Credits();
    const questions = new ReportQuestionService(f.db, reports, gateway, credits);
    const now = new Date('2026-10-23T09:00:00Z');
    const answer = unwrap(await questions.ask(f.a, ' pichle hafte kitni sale hui? ', false, now));
    expect(asked).toEqual(['pichle hafte kitni sale hui?']);
    expect(answer).toMatchObject({ breakdown: 'day', columns: ['orders', 'total_sales'] });
    expect(answer.report.columns.map((column) => column.key)).toEqual(['orders', 'total_sales']);
    const day = answer.report.rows.find((row) => row.label === '2026-10-20');
    expect(day?.values).toEqual([1, 400_000n]);
    expect(credits.spent).toEqual(['report_question']);
    expect(await questions.asking(f.a, now)).toEqual({
      available: true,
      usedToday: 1,
      limitPerDay: REPORT_QUESTION_DAILY,
    });
  });

  it("says why it can't answer, and asks nothing once the day's or the credits are used", async () => {
    const { gateway, asked } = gatewayAnswering(() => ({
      answerable: false,
      reason: 'Ye dukaan ke numbers ka sawal nahi',
    }));
    const credits = new Credits();
    const questions = new ReportQuestionService(f.db, reports, gateway, credits);
    const refused = await questions.ask(f.a, 'kal mausam kaisa hoga?', true);
    expect(errorsOf(refused)).toEqual([['question', 'INVALID']]);
    expect(!refused.ok && refused.errors[0]!.message).toBe('Ye dukaan ke numbers ka sawal nahi');
    expect(credits.spent).toEqual([]);
    expect(errorsOf(await questions.ask(f.a, '  ', true))).toEqual([['question', 'BLANK']]);

    credits.left = 0;
    expect(errorsOf(await questions.ask(f.a, 'sales?', true))).toEqual([['base', 'TOO_MANY']]);
    credits.left = 10;
    await f.admin.query(
      `INSERT INTO orders.report_questions (shop_id, question, outcome)
       SELECT $1, 'x', 'answered' FROM generate_series(1, $2)`,
      [f.a.shopId, REPORT_QUESTION_DAILY],
    );
    expect(errorsOf(await questions.ask(f.a, 'sales?', true))).toEqual([['base', 'TOO_MANY']]);
    expect(asked).toEqual(['kal mausam kaisa hoga?']);
    // Without the AI, none.
    expect(
      errorsOf(await new ReportQuestionService(f.db, reports).ask(f.a, 'sales?', true)),
    ).toEqual([['base', 'UNAVAILABLE']]);
  });
});
