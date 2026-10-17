import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { statusSubscriptionPage, type StatusSubscriptionState } from './status-page.js';
import {
  STATUS_SUBSCRIPTION_PATH,
  StatusSubscriptionsService,
} from './status-subscriptions.service.js';

/** Never kept: a link's page carries its secret, and asking is never the same twice. */
const PRIVATE_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * The status page's emails (ADR-535): `POST /status/subscribe` from its form, and each address's
 * link, `/status/subscription/<token>`, whose page confirms or stops them with a button, never on
 * opening, as mail scanners open links.
 */
@Controller()
export class StatusSubscriptionController {
  constructor(private readonly subscriptions: StatusSubscriptionsService) {}

  @Post('status/subscribe')
  async subscribe(@Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    const email = fieldOf(body, 'email');
    const asked = await this.subscriptions.subscribe(email);
    await send(reply, { kind: asked ? 'asked' : 'wrong' });
  }

  @Get(`${STATUS_SUBSCRIPTION_PATH}/:token`)
  async open(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const view = await this.subscriptions.view(token);
    await send(reply, view ? { kind: 'link', view } : { kind: 'not_found' });
  }

  @Post(`${STATUS_SUBSCRIPTION_PATH}/:token`)
  async act(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (fieldOf(body, 'action') === 'stop') {
      const stopped = await this.subscriptions.unsubscribe(token);
      return send(reply, { kind: stopped ? 'stopped' : 'not_found' });
    }
    const view = await this.subscriptions.confirm(token);
    await send(reply, view ? { kind: 'link', view } : { kind: 'not_found' });
  }
}

function fieldOf(body: unknown, name: string): string {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return typeof fields[name] === 'string' ? fields[name] : '';
}

async function send(reply: FastifyReply, state: StatusSubscriptionState): Promise<void> {
  const page = statusSubscriptionPage(state);
  await reply
    .code(page.status)
    .headers(PRIVATE_PAGE_HEADERS)
    .header('content-security-policy', page.contentSecurityPolicy)
    .header('content-type', 'text/html; charset=utf-8')
    .send(page.html);
}
