import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ConversationsService } from './conversations.service.js';
import type { MessagesService, StatusUpdate } from './messages.service.js';
import type { SupportInbox } from './support-inbox.js';
import type { CallResult } from './voice-webhook.js';
import { VoiceWebhookController, WhatsAppWebhookController } from './webhooks.controller.js';
import type { InboundMessage } from './whatsapp-webhook.js';
import type { WhatsAppTemplatesService } from './whatsapp-templates.service.js';

const SETTINGS = { appSecret: 'whatsapp-app-secret-1234', verifyToken: 'verify-token-5678' };
const SHARED = '100000000000001';
const SUPPORT = '300000000000003';

/** What each service behind the webhook was handed. */
function services(options: { inbox?: boolean; supportAnswers?: string[] } = {}) {
  const seen = {
    inbox: [] as InboundMessage[],
    stopped: [] as string[],
    supportStatuses: [] as string[],
  };
  const messages = {
    recordStatuses: async (updates: readonly StatusUpdate[]) => ({
      changed: 0,
      unmatched: [...updates],
    }),
    optOut: async (_channel: string, from: string) => {
      seen.stopped.push(from);
    },
    recordReply: async () => undefined,
  };
  const conversations = {
    recordStatuses: async (updates: readonly StatusUpdate[]) => [...updates],
    recordInbound: async (message: InboundMessage) => {
      seen.inbox.push(message);
      return null;
    },
  };
  const templates = { recordStatuses: async () => undefined };
  const support = {
    kept: [] as InboundMessage[],
    async recordWhatsApp(message: InboundMessage) {
      this.kept.push(message);
      return true;
    },
    async recordStatuses(updates: readonly StatusUpdate[]) {
      seen.supportStatuses.push(...updates.map((update) => update.providerMessageId));
      return updates.filter(
        (update) => !(options.supportAnswers ?? []).includes(update.providerMessageId),
      );
    },
  } satisfies SupportInbox & { kept: InboundMessage[] };
  const controller = new WhatsAppWebhookController(
    SETTINGS,
    messages as unknown as MessagesService,
    templates as unknown as WhatsAppTemplatesService,
    conversations as unknown as ConversationsService,
    { phoneNumberId: SUPPORT },
    options.inbox === false ? null : support,
  );
  return { controller, seen, support };
}

/** A change of the messages field, signed as Meta signs it. */
function delivered(value: object) {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${createHmac('sha256', SETTINGS.appSecret).update(rawBody).digest('hex')}`;
  return [{ body, rawBody } as unknown as FastifyRequest & { rawBody: Buffer }, signature] as const;
}

const now = () => String(Math.floor(Date.now() / 1000));

function written(to: string, text: string, id: string) {
  return delivered({
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: to },
    messages: [{ from: '923001234567', id, timestamp: now(), type: 'text', text: { body: text } }],
  });
}

describe("WhatsApp's webhook and Hatti's support number (ADR-560)", () => {
  it("hands what is written to the support number to Hatti's support alone", async () => {
    const { controller, seen, support } = services();
    await controller.receive(...written(SUPPORT, 'STOP: orders do not book', 'wamid.S1'));
    expect(support.kept).toMatchObject([{ from: '+923001234567', id: 'wamid.S1', to: SUPPORT }]);
    // No shop's inbox keeps it, and no shop's messages stop, whatever it says.
    expect(seen.inbox).toEqual([]);
    expect(seen.stopped).toEqual([]);

    // What a customer writes to Hatti's shared number goes on as before.
    await controller.receive(...written(SHARED, 'STOP', 'wamid.C1'));
    expect(support.kept).toHaveLength(1);
    expect(seen.stopped).toEqual(['+923001234567']);
    expect(seen.inbox.map((message) => message.id)).toEqual(['wamid.C1']);
  });

  it('ignores what is written to the support number where no inbox keeps it', async () => {
    const { controller, seen } = services({ inbox: false });
    expect(await controller.receive(...written(SUPPORT, 'Help', 'wamid.S2'))).toEqual({
      received: 1,
    });
    expect(seen.inbox).toEqual([]);
  });

  it("follows the support number's answers with the statuses no shop's message takes", async () => {
    const { controller, seen } = services({ supportAnswers: ['wamid.A1'] });
    const status = (id: string) => ({
      id,
      status: 'delivered',
      timestamp: now(),
      recipient_id: '923001234567',
    });
    // An answer of Hatti's is found, and asks Meta for nothing again.
    await controller.receive(...delivered({ statuses: [status('wamid.A1')] }));
    expect(seen.supportStatuses).toEqual(['wamid.A1']);
    // One no one knows yet is asked for again, as before.
    await expect(
      controller.receive(...delivered({ statuses: [status('wamid.X1')] })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(seen.supportStatuses).toEqual(['wamid.A1', 'wamid.X1']);
  });
});

describe("The voice gateway's webhook (ADR-611)", () => {
  const SECRET = 'voice-gateway-secret';
  /** A call's end, signed as the gateway signs it. */
  function told(body: object, secret = SECRET) {
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return [
      { body, rawBody } as unknown as FastifyRequest & { rawBody: Buffer },
      signature,
    ] as const;
  }

  function controller(known: boolean, settings: { secret: string } | null = { secret: SECRET }) {
    const heard: CallResult[] = [];
    const messages = {
      recordCall: async (call: CallResult) => {
        heard.push(call);
        return known;
      },
    };
    return {
      heard,
      webhook: new VoiceWebhookController(settings, messages as unknown as MessagesService),
    };
  }

  it("hands each call's end to the messages, signed with the shared secret alone", async () => {
    const { webhook, heard } = controller(true);
    const at = new Date().toISOString();
    expect(
      await webhook.receive(...told({ id: 'call-77', result: 'answered', key: '1', at })),
    ).toEqual({ received: 1 });
    expect(heard).toEqual([{ callId: 'call-77', result: 'answered', key: '1', at: new Date(at) }]);
    await expect(
      webhook.receive(...told({ id: 'call-77', result: 'answered' }, 'another-secret')),
    ).rejects.toMatchObject({ status: 401 });
    // What says no call's end is taken, and changes nothing.
    expect(await webhook.receive(...told({ id: 'call-77', result: 'ringing' }))).toEqual({
      received: 0,
    });
    expect(heard).toHaveLength(1);
  });

  it('asks again for a call not known yet, and answers 404 without the gateway', async () => {
    const early = controller(false);
    await expect(
      early.webhook.receive(...told({ id: 'call-9', result: 'no_answer' })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Long ago: given up on.
    expect(
      await early.webhook.receive(
        ...told({ id: 'call-9', result: 'no_answer', at: '2026-01-01T00:00:00Z' }),
      ),
    ).toEqual({ received: 1 });
    await expect(
      controller(true, null).webhook.receive(...told({ id: 'call-9', result: 'busy' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});
