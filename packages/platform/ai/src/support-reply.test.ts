import { describe, expect, it } from 'vitest';
import { AiGateway } from './gateway.js';
import { SUPPORT_REPLY_LIMITS, draftSupportReply } from './support-reply.js';

/** A fake provider answering once through the reply tool, each request kept. */
function provider(input: unknown) {
  const requests: { messages: { content: string }[] }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as { messages: { content: string }[] });
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'give_reply', input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 900, output_tokens: 60 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { gateway: new AiGateway({ apiKey: 'sk-test', model: 'model', fetch }), requests };
}

describe("A reply to a shop's customer (MSG-07, ADR-849)", () => {
  it('drafts it from the facts and the conversation, the latest messages alone', async () => {
    const { gateway, requests } = provider({
      reply: 'Aap ka order #1023 kal Leopards se nikla hai.',
      hand_off: false,
    });
    const history = Array.from({ length: SUPPORT_REPLY_LIMITS.history + 3 }, (_, index) => ({
      from: index % 2 === 0 ? ('customer' as const) : ('shop' as const),
      text: `message ${index}`,
    }));
    history.push({ from: 'customer', text: 'mera order kahan hai?' });
    expect(
      await draftSupportReply(gateway, {
        shopName: 'Zari',
        facts: 'Order #1023: shipped with Leopards on 20 October.',
        history,
      }),
    ).toEqual({
      ok: true,
      value: { reply: 'Aap ka order #1023 kal Leopards se nikla hai.', handOff: false },
      usage: { inputTokens: 900, outputTokens: 60 },
    });
    const prompt = requests[0]!.messages[0]!.content;
    expect(prompt).toContain(
      '<facts>\nOrder #1023: shipped with Leopards on 20 October.\n</facts>',
    );
    expect(prompt).toContain('<customer>\nmera order kahan hai?\n</customer>');
    expect(prompt).not.toContain('message 0\n');
    expect(prompt.match(/<(customer|shop)>\n/g)).toHaveLength(SUPPORT_REPLY_LIMITS.history);
  });

  it('hands off when it says so, and refuses an answer without a reply', async () => {
    expect(
      await draftSupportReply(
        provider({ reply: 'Someone from the shop will reply soon.', hand_off: true }).gateway,
        { shopName: 'Zari', facts: '', history: [{ from: 'customer', text: 'I want a refund' }] },
      ),
    ).toMatchObject({ ok: true, value: { handOff: true } });
    expect(
      (
        await draftSupportReply(provider({ reply: ' ', hand_off: false }).gateway, {
          shopName: 'Zari',
          facts: '',
          history: [{ from: 'customer', text: 'hi' }],
        })
      ).ok,
    ).toBe(false);
  });
});
