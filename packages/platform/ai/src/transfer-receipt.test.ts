import { describe, expect, it } from 'vitest';
import { AiGateway } from './gateway.js';
import { readTransferReceipt } from './transfer-receipt.js';

/** A fake provider answering once through the receipt tool, each request kept. */
function provider(input: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'give_receipt', input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1500, output_tokens: 90 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    gateway: new AiGateway({ apiKey: 'sk-test', model: 'model-from-config', fetch }),
    requests,
  };
}

const JPEG = { mediaType: 'image/jpeg' as const, data: Buffer.from([0xff, 0xd8, 0xff, 1]) };
const PDF = { mediaType: 'application/pdf' as const, data: Buffer.from('%PDF-1.4') };

describe("A customer's receipt for their transfer, read (PAY-08, ADR-845)", () => {
  it('reads what it says, the picture sent alone, its amount in paisa', async () => {
    const { gateway, requests } = provider({
      receipt: true,
      amount: 'Rs. 4,500.5',
      currency: 'PKR',
      date: '2026-10-20',
      reference: '  TID 0012 3456  ',
      sender_name: 'Ayesha Khan',
      sender_bank: 'Meezan Bank',
      recipient_name: 'Gul Ahmed Store',
      recipient_account: 'PK36****4567',
    });
    expect(await readTransferReceipt(gateway, JPEG)).toEqual({
      ok: true,
      value: {
        receipt: true,
        amountMinor: 450_050n,
        paidOn: '2026-10-20',
        reference: 'TID 0012 3456',
        senderName: 'Ayesha Khan',
        senderBank: 'Meezan Bank',
        recipientName: 'Gul Ahmed Store',
        recipientAccount: 'PK36****4567',
      },
      usage: { inputTokens: 1500, outputTokens: 90 },
    });
    const content = (requests[0]!.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((part) => part.type)).toEqual(['image', 'text']);
  });

  it('gives a PDF as a document, and leaves out what it could not read', async () => {
    const { gateway, requests } = provider({
      receipt: true,
      amount: 'about five thousand',
      date: '20/10/2026',
      reference: '',
    });
    expect(await readTransferReceipt(gateway, PDF)).toMatchObject({
      ok: true,
      value: { receipt: true, amountMinor: null, paidOn: null, reference: null },
    });
    const content = (
      requests[0]!.messages as { content: { type: string; source?: unknown }[] }[]
    )[0]!.content;
    expect(content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
    });
    // Not rupees: no amount taken.
    expect(
      await readTransferReceipt(
        provider({ receipt: true, amount: '120.00', currency: 'USD' }).gateway,
        JPEG,
      ),
    ).toMatchObject({ value: { amountMinor: null } });
    // A day that isn't one.
    expect(
      await readTransferReceipt(provider({ receipt: true, date: '2026-02-30' }).gateway, JPEG),
    ).toMatchObject({ value: { paidOn: null } });
  });

  it("says when it isn't a receipt, and refuses an answer without one", async () => {
    expect(await readTransferReceipt(provider({ receipt: false }).gateway, JPEG)).toMatchObject({
      ok: true,
      value: { receipt: false },
    });
    expect((await readTransferReceipt(provider({ amount: '500' }).gateway, JPEG)).ok).toBe(false);
  });
});
