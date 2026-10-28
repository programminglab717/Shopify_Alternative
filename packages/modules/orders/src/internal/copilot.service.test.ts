import 'reflect-metadata';
import { AiGateway } from '@hatti/ai';
import { AiCredits, type AiCreditBalance, type AiCreditUse } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COPILOT_DAILY, CopilotService } from './copilot.service.js';
import { CustomReportService } from './custom-reports.js';
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

/** A provider drafting each request through the draft tool, as `answer` says; each prompt kept. */
function gatewayAnswering(answer: (request: string) => unknown) {
  const prompts: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    const prompt = body.messages[0]!.content;
    prompts.push(prompt);
    const request = /<request>\n([\s\S]*)\n<\/request>/.exec(prompt)![1]!;
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'draft', input: answer(request) }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 600, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { gateway: new AiGateway({ apiKey: 'sk-test', model: 'model', fetch }), prompts };
}

const NOW = new Date('2026-10-28T10:00:00Z');

describe.skipIf(!server)('The merchant copilot (AI-01, ADR-894)', () => {
  let f: OrdersFixture;
  let reports: CustomReportService;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    reports = new CustomReportService(f.db, new SalesReportService(f.db));
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const copilot = (answer: (request: string) => unknown, credits = new Credits()) => {
    const { gateway, prompts } = gatewayAnswering(answer);
    return {
      service: new CopilotService(f.db, f.segments, reports, gateway, credits),
      prompts,
      credits,
    };
  };

  it('drafts a discount code and a segment counted, checked, nothing made, each spending a credit', async () => {
    const { service, prompts, credits } = copilot((request) =>
      request.startsWith('Eid')
        ? { kind: 'discount', discount: { code: 'eid15', percentage: 15 } }
        : {
            kind: 'segment',
            segment: { name: 'Repeat buyers', query: 'number_of_orders >= 2' },
          },
    );
    expect(unwrap(await service.draft(f.a, 'Eid ke liye 15% off code', true, NOW))).toMatchObject({
      kind: 'discount',
      discount: { code: 'EID15', percentage: 15, amount: null, freeShipping: false },
    });
    expect(prompts[0]).toContain('Today is 2026-10-28.');
    expect(prompts[0]).toContain('number_of_orders');
    expect(unwrap(await service.draft(f.a, 'jo do baar order kar chuke', true, NOW))).toEqual({
      kind: 'segment',
      name: 'Repeat buyers',
      query: 'number_of_orders >= 2',
      customers: 0,
    });
    expect(credits.spent).toEqual(['copilot', 'copilot']);
    // Nothing is made: no segments, no codes.
    const { rows } = await f.admin.query(
      'SELECT (SELECT count(*) FROM customers.segments)::int AS segments',
    );
    expect(rows[0]).toEqual({ segments: 0 });
    expect(await service.asking(f.a, NOW)).toEqual({
      available: true,
      usedToday: 2,
      limitPerDay: COPILOT_DAILY,
    });
    expect((await service.asking(f.b, NOW)).usedToday).toBe(0);
  });

  it("says why there's no draft: none asked for, a segment that doesn't check, or the AI away", async () => {
    const { service, credits } = copilot((request) =>
      request === 'messages bhejo'
        ? { kind: 'none', reason: 'Copilot messages nahi bhejta' }
        : { kind: 'segment', segment: { name: 'Bad', query: 'favourite_colour = red' } },
    );
    expect(errorsOf(await service.draft(f.a, 'messages bhejo', true, NOW))).toEqual([
      ['request', 'INVALID'],
    ]);
    expect(errorsOf(await service.draft(f.a, 'red lovers', true, NOW))).toEqual([
      ['request', 'INVALID'],
    ]);
    expect(credits.spent).toEqual([]);
    const { rows } = await f.admin.query(
      'SELECT outcome FROM orders.copilot_requests ORDER BY created_at, outcome',
    );
    expect(rows.map((row: { outcome: string }) => row.outcome).sort()).toEqual([
      'none',
      'unchecked',
    ]);
    expect(errorsOf(await service.draft(f.a, '  ', true, NOW))).toEqual([['request', 'BLANK']]);
    const away = new CopilotService(f.db, f.segments, reports, null, new Credits());
    expect(errorsOf(await away.draft(f.a, 'x', true, NOW))).toEqual([['base', 'UNAVAILABLE']]);
    expect((await away.asking(f.a, NOW)).available).toBe(false);
    const spentOut = new Credits();
    spentOut.left = 0;
    expect(
      errorsOf(await copilot(() => ({}), spentOut).service.draft(f.a, 'x', true, NOW)),
    ).toEqual([['base', 'TOO_MANY']]);
  });

  it('drafts a broadcast, its audience counted, and refuses one whose time has passed (ADR-896)', async () => {
    const { service, credits } = copilot((request) => ({
      kind: 'broadcast',
      broadcast:
        request === 'kal subah sab ko'
          ? { name: 'Morning sale', send_at: '2026-10-29T09:00' }
          : request === 'aaj subah'
            ? { name: 'Too late', send_at: '2026-10-28T09:00' }
            : request === 'red lovers'
              ? { name: 'Red', audience_query: 'favourite_colour = red' }
              : {
                  name: 'Repeat buyers',
                  channel: 'sms',
                  audience_query: 'number_of_orders >= 2',
                  text: 'Eid sale kal se!',
                },
    }));
    expect(unwrap(await service.draft(f.a, 'kal subah sab ko', true, NOW))).toEqual({
      kind: 'broadcast',
      broadcast: {
        name: 'Morning sale',
        channel: 'whatsapp',
        query: null,
        text: null,
        sendAt: new Date('2026-10-29T04:00:00Z'),
      },
      customers: null,
    });
    expect(unwrap(await service.draft(f.a, 'repeat walon ko SMS', true, NOW))).toMatchObject({
      broadcast: { channel: 'sms', query: 'number_of_orders >= 2', text: 'Eid sale kal se!' },
      customers: 0,
    });
    // 15:00 in Pakistan on the 28th: nine in the morning has passed.
    expect(errorsOf(await service.draft(f.a, 'aaj subah', true, NOW))).toEqual([
      ['request', 'INVALID'],
    ]);
    expect(errorsOf(await service.draft(f.a, 'red lovers', true, NOW))).toEqual([
      ['request', 'INVALID'],
    ]);
    expect(credits.spent).toEqual(['copilot', 'copilot']);
  });

  it('runs a report drafted, and stops at the day’s limit', async () => {
    const { service } = copilot(() => ({
      kind: 'report',
      report: { breakdown: 'day', columns: ['orders'], period: 'last_7_days' },
    }));
    const draft = unwrap(await service.draft(f.a, 'pichle hafte ke orders', true, NOW));
    expect(draft).toMatchObject({ kind: 'report', breakdown: 'day', period: 'last_7_days' });
    expect(draft.kind === 'report' && draft.report.rows.length).toBe(7);
    await f.admin.query(
      `INSERT INTO orders.copilot_requests (shop_id, request, outcome, created_at)
       SELECT $1, 'x', 'none', $2 FROM generate_series(1, $3)`,
      [f.a.shopId, NOW.toISOString(), COPILOT_DAILY],
    );
    expect(errorsOf(await service.draft(f.a, 'aur?', true, NOW))).toEqual([['base', 'TOO_MANY']]);
  });
});
