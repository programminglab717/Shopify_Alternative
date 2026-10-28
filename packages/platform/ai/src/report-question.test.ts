import { describe, expect, it } from 'vitest';
import { AiGateway } from './gateway.js';
import { readReportQuestion, type ReportChoices } from './report-question.js';

/** A fake provider answering once through the report tool, each request kept. */
function provider(input: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'choose_report', input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 300, output_tokens: 40 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    gateway: new AiGateway({ apiKey: 'sk-test', model: 'model-from-config', fetch }),
    requests,
  };
}

const CHOICES: ReportChoices = {
  breakdowns: ['day', 'week', 'month', 'product'],
  periods: ['today', 'last_7_days', 'last_month'],
  salesColumns: ['orders', 'total_sales', 'average_order_value'],
  productColumns: ['units_sold', 'gross_sales'],
};

describe("A merchant's question read into a report (ANL-08, ADR-844)", () => {
  it('reads it into a report of the choices alone, the question sent and nothing else', async () => {
    const { gateway, requests } = provider({
      answerable: true,
      breakdown: 'day',
      // A product's column on a report of sales, one twice, and one Hatti hasn't: left out.
      columns: ['total_sales', 'units_sold', 'total_sales', 'orders', 'secret'],
      period: 'last_7_days',
    });
    expect(await readReportQuestion(gateway, 'pichle hafte kitni sale hui?', CHOICES)).toEqual({
      ok: true,
      value: {
        answerable: true,
        breakdown: 'day',
        columns: ['total_sales', 'orders'],
        period: 'last_7_days',
      },
      usage: { inputTokens: 300, outputTokens: 40 },
    });
    expect(JSON.stringify(requests[0])).toContain('pichle hafte kitni sale hui?');
    const tool = (
      requests[0]!.tools as { input_schema: { properties: { period: unknown } } }[]
    )[0]!;
    expect(tool.input_schema.properties.period).toEqual({
      type: 'string',
      enum: ['today', 'last_7_days', 'last_month'],
    });
  });

  it('says why none answers it, and refuses a reading outside the choices', async () => {
    expect(
      await readReportQuestion(
        provider({ answerable: false, reason: 'Ye mausam ka sawal hai' }).gateway,
        'kal mausam kaisa hoga?',
        CHOICES,
      ),
    ).toMatchObject({ ok: true, value: { answerable: false, reason: 'Ye mausam ka sawal hai' } });
    for (const reading of [
      { answerable: true, breakdown: 'year', columns: ['orders'], period: 'today' },
      { answerable: true, breakdown: 'day', columns: ['orders'], period: 'forever' },
      { answerable: true, breakdown: 'product', columns: ['orders'], period: 'today' },
    ]) {
      expect((await readReportQuestion(provider(reading).gateway, 'sales?', CHOICES)).ok).toBe(
        false,
      );
    }
  });
});
