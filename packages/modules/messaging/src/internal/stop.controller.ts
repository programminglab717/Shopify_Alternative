import { Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { MessagesService } from './messages.service.js';
import { STOP_LINK_PATH, messageIdOf, stopLinkPage, type StopLinkView } from './stop-links.js';

const PRIVATE_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * Where an SMS campaign's link to stop goes (ADR-458): /s/<token> on the core's own address. Its
 * page asks first, so a link opened by a phone's preview stops nothing; the customer's tap posts
 * the page back, and the shop's SMS to the number stop.
 */
@Controller(STOP_LINK_PATH)
export class StopLinkController {
  constructor(private readonly messages: MessagesService) {}

  @Get(':token')
  async open(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const id = messageIdOf(token);
    await send(reply, id ? await this.messages.stopLink(id) : null);
  }

  @Post(':token')
  async stop(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const id = messageIdOf(token);
    await send(reply, id ? await this.messages.stopByLink(id) : null);
  }
}

async function send(reply: FastifyReply, view: StopLinkView | null): Promise<void> {
  const page = stopLinkPage(view);
  await reply
    .code(page.status)
    .headers(PRIVATE_PAGE_HEADERS)
    .header('content-security-policy', page.contentSecurityPolicy)
    .header('content-type', 'text/html; charset=utf-8')
    .send(page.html);
}
