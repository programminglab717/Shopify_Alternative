import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MessagesService } from './messages.service.js';
import { asksToStop } from './templates.js';
import { parseWhatsAppWebhook, signatureValid } from './whatsapp-webhook.js';

/** What the webhook of Hatti's WhatsApp app checks requests with; null without WhatsApp. */
export interface WhatsAppWebhookSettings {
  /** The app's secret, which Meta signs each request with. */
  appSecret: string;
  /** Agreed with Meta when the webhook was set up, which its first request repeats. */
  verifyToken: string;
}

export const WHATSAPP_WEBHOOK = Symbol('WHATSAPP_WEBHOOK');

/**
 * How long a status for a message not found is taken to be early, before its sender recorded the
 * ID it was sent with: Meta is asked to send it again.
 */
const EARLY_MS = 10 * 60_000;

/**
 * WhatsApp's webhook (ADR-146): how the messages Hatti's shared number sent went, and what
 * customers wrote back, of which "STOP" or "band karo" stops the shop they answered, or else the
 * shop that last wrote to them, and a button pressed is an answer for the worker (ADR-147). The host keeps each request's raw body as `rawBody`, which Meta's
 * signature covers. Everything in it can be heard twice: Meta sends again what was not taken.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    @Inject(WHATSAPP_WEBHOOK) private readonly settings: WhatsAppWebhookSettings | null,
    private readonly messages: MessagesService,
  ) {}

  /** Meta's check, as the webhook is set up: the token it was given, and a challenge to echo. */
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const expected = this.settings?.verifyToken;
    if (!expected || mode !== 'subscribe' || !token || !challenge || !sameText(token, expected)) {
      return reply.code(403).send();
    }
    return reply.type('text/plain; charset=utf-8').send(challenge.slice(0, 200));
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<{ received: number }> {
    if (!this.settings) throw new NotFoundException();
    if (!request.rawBody || !signatureValid(request.rawBody, signature, this.settings.appSecret)) {
      throw new UnauthorizedException('The request is not signed with the app secret');
    }
    const { statuses, inbound } = parseWhatsAppWebhook(request.body);
    const { unmatched } = await this.messages.recordStatuses(statuses);
    for (const message of inbound) {
      if (message.text && asksToStop(message.text)) {
        await this.messages.optOut('whatsapp', message.from, message.text, message.replyTo);
      } else if (message.replyTo && message.payload) {
        // A button pressed: the worker acts on the answer, as the message's kind says.
        await this.messages.recordReply({
          replyTo: message.replyTo,
          from: message.from,
          answer: message.payload,
          at: message.at,
        });
      }
    }
    const now = Date.now();
    if (unmatched.some((status) => now - status.at.getTime() < EARLY_MS)) {
      throw new ServiceUnavailableException('A message is not known yet: send it again');
    }
    return { received: statuses.length + inbound.length };
  }
}

function sameText(a: string, b: string): boolean {
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
}
