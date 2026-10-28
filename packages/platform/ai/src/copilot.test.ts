import { describe, expect, it } from 'vitest';
import { readCopilotRequest, type CopilotChoices } from './copilot.js';
import { AiGateway } from './gateway.js';

/** A fake provider answering once through the draft tool, each request kept. */
function provider(input: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'draft', input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 500, output_tokens: 60 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    gateway: new AiGateway({ apiKey: 'sk-test', model: 'model-from-config', fetch }),
    requests,
  };
}

const CHOICES: CopilotChoices = {
  segmentFields: [
    {
      name: 'number_of_orders',
      type: 'number',
      description: 'Orders placed.',
      example: 'number_of_orders >= 2',
    },
  ],
  report: {
    breakdowns: ['day', 'product'],
    periods: ['today', 'last_7_days'],
    salesColumns: ['orders', 'total_sales'],
    productColumns: ['units_sold'],
  },
  today: '2027-03-01',
};

const read = (input: unknown, request = 'x') =>
  readCopilotRequest(provider(input).gateway, request, CHOICES);

describe("The merchant copilot's drafts (AI-01, ADR-894)", () => {
  it('drafts a discount code, checked, with the request, fields and today sent and nothing else', async () => {
    const { gateway, requests } = provider({
      kind: 'discount',
      discount: {
        code: 'eid15',
        title: 'Eid sale',
        percentage: 15,
        minimum_subtotal: 3000,
        ends_on: '2027-03-31',
        once_per_customer: true,
      },
    });
    expect(await readCopilotRequest(gateway, 'Eid ke liye 15% off code bana do', CHOICES)).toEqual({
      ok: true,
      value: {
        kind: 'discount',
        discount: {
          code: 'EID15',
          title: 'Eid sale',
          percentage: 15,
          amount: null,
          freeShipping: false,
          minimumSubtotal: '3000',
          startsOn: null,
          endsOn: '2027-03-31',
          oncePerCustomer: true,
          usageLimit: null,
        },
      },
      usage: { inputTokens: 500, outputTokens: 60 },
    });
    const sent = JSON.stringify(requests[0]);
    expect(sent).toContain('Eid ke liye 15% off code bana do');
    expect(sent).toContain('Today is 2027-03-01.');
    expect(sent).toContain('number_of_orders (number): Orders placed.');
  });

  it('refuses a discount giving none or two things, a bad code, or days past or reversed', async () => {
    for (const discount of [
      { code: 'EID' },
      { code: 'EID', percentage: 10, free_shipping: true },
      { code: 'EID SALE', percentage: 10 },
      { code: 'EID', percentage: 120 },
      { code: 'EID', amount: 500.5 },
      { code: 'EID', amount: 500, ends_on: '2027-02-01' },
      { code: 'EID', amount: 500, starts_on: '2027-03-10', ends_on: '2027-03-05' },
      { code: 'EID', amount: 500, ends_on: '2029-01-01' },
    ]) {
      expect((await read({ kind: 'discount', discount })).ok, JSON.stringify(discount)).toBe(false);
    }
    expect(
      await read({ kind: 'discount', discount: { code: 'SHIPFREE', free_shipping: true } }),
    ).toMatchObject({ ok: true, value: { discount: { freeShipping: true, percentage: null } } });
  });

  it('drafts a segment and a report of the choices alone, or says why there is none', async () => {
    expect(
      await read({
        kind: 'segment',
        segment: { name: ' Repeat buyers ', query: 'number_of_orders >= 2' },
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: 'segment', name: 'Repeat buyers', query: 'number_of_orders >= 2' },
    });
    expect((await read({ kind: 'segment', segment: { name: 'x' } })).ok).toBe(false);
    expect(
      await read({
        kind: 'report',
        report: { breakdown: 'product', columns: ['orders', 'units_sold'], period: 'today' },
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: 'report', breakdown: 'product', columns: ['units_sold'], period: 'today' },
    });
    expect(
      (await read({ kind: 'report', report: { breakdown: 'year', columns: [], period: 'today' } }))
        .ok,
    ).toBe(false);
    expect(
      await read({ kind: 'none', reason: 'Messages bhejna copilot nahi karta' }),
    ).toMatchObject({
      ok: true,
      value: { kind: 'none', reason: 'Messages bhejna copilot nahi karta' },
    });
    expect((await read({ kind: 'delete_everything' })).ok).toBe(false);
  });

  it('drafts a broadcast, its time in Pakistan, SMS with its words, and refuses one past its limits (ADR-896)', async () => {
    expect(
      await read({
        kind: 'broadcast',
        broadcast: {
          name: 'Eid sale',
          audience_query: "city = 'Lahore'",
          send_at: '2027-03-05T18:30',
          text: 'ignored for WhatsApp',
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        kind: 'broadcast',
        broadcast: {
          name: 'Eid sale',
          channel: 'whatsapp',
          query: "city = 'Lahore'",
          text: null,
          sendAt: new Date('2027-03-05T13:30:00Z'),
        },
      },
    });
    expect(
      await read({
        kind: 'broadcast',
        broadcast: { name: 'Sale', channel: 'sms', text: 'Kal sale hai! 20% off' },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        broadcast: { channel: 'sms', text: 'Kal sale hai! 20% off', query: null, sendAt: null },
      },
    });
    for (const broadcast of [
      { name: 'Sale', channel: 'sms' },
      { name: 'Sale', channel: 'sms', text: 'x'.repeat(321) },
      { name: 'Sale', send_at: '2027-02-20T10:00' },
      { name: 'Sale', send_at: '2027-04-15T10:00' },
      { name: 'Sale', send_at: '2027-03-05T25:00' },
      { name: '' },
    ]) {
      expect((await read({ kind: 'broadcast', broadcast })).ok, JSON.stringify(broadcast)).toBe(
        false,
      );
    }
  });
});
