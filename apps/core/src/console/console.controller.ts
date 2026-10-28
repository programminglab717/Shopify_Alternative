import { SUPPORT_LIMITS, SupportService, type OpenSupportRequest } from '@hatti/billing/public';
import {
  AuthErrorFilter,
  ConsoleAuthService,
  ConsoleGuard,
  consoleAgentOf,
  type ConsoleActionRecord,
} from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** A refusal as the console reads it: `{ error: { code, message, fields? } }`. */
export function consoleError(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
): HttpException {
  return new HttpException({ error: { code, message, ...(fields && { fields }) } }, status);
}

function supportRequestJson(request: OpenSupportRequest, now: Date) {
  return {
    id: toPublicId('supportRequest', request.id),
    shop: { id: toPublicId('shop', request.shopId), name: request.shopName, plan: request.plan },
    channel: request.channel,
    topic: request.topic,
    language: request.language,
    priority: request.priority,
    message: request.message,
    callBack: request.callBack,
    createdAt: request.createdAt.toISOString(),
    dueAt: request.dueAt.toISOString(),
    late: request.dueAt.getTime() <= now.getTime(),
    lastInbound: request.lastInbound
      ? { text: request.lastInbound.text, at: request.lastInbound.at.toISOString() }
      : null,
  };
}

function actionJson(action: ConsoleActionRecord) {
  return {
    id: action.id,
    email: action.email,
    action: action.action,
    subject: action.subject,
    details: action.details,
    at: action.at.toISOString(),
  };
}

/**
 * Hatti's console (ADR-876), at `/console/api`, for Hatti's own people signed in through Hatti's
 * provider, never through the Admin API: shops' support requests to answer, and the log of what
 * was done here, each thing written down before it is done.
 */
@Controller('console/api')
@UseGuards(ConsoleGuard)
@UseFilters(AuthErrorFilter)
export class ConsoleController {
  constructor(
    private readonly console: ConsoleAuthService,
    private readonly support: SupportService,
  ) {}

  /** Shops' requests waiting for an answer, the most urgent then the oldest first (ADR-525). */
  @Get('support-requests')
  async supportRequests() {
    const now = new Date();
    return {
      requests: (await this.support.waiting()).map((each) => supportRequestJson(each, now)),
    };
  }

  /**
   * Answers a request, `{ answer }`, as the signed-in agent: the shop's admin shows it, and it goes
   * back on WhatsApp to those who wrote there, within the day WhatsApp allows (ADR-560).
   */
  @Post('support-requests/:id/answer')
  @HttpCode(200)
  async answer(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const requestId = tryFromPublicId(id, 'supportRequest');
    const text = (body as { answer?: unknown } | null)?.answer;
    if (!requestId) throw consoleError(404, 'NOT_FOUND', 'No such request waits for an answer');
    if (typeof text !== 'string' || !text.trim()) {
      throw consoleError(422, 'BLANK', 'Say what Hatti answers', { answer: 'BLANK' });
    }
    if (text.trim().length > SUPPORT_LIMITS.answer) {
      throw consoleError(
        422,
        'TOO_LONG',
        `An answer is at most ${SUPPORT_LIMITS.answer} characters`,
        { answer: 'TOO_LONG' },
      );
    }
    await this.console.record(agent, 'support_request.answer', id, {
      characters: text.trim().length,
    });
    const answered = await this.support.answer(requestId, text, agent.name);
    if (!answered.ok) {
      const error = answered.errors[0]!;
      throw consoleError(
        error.code === 'NOT_FOUND' ? 404 : 422,
        error.code ?? 'INVALID',
        error.message,
      );
    }
    return {
      request: supportRequestJson(answered.value, new Date()),
      whatsapp: answered.value.whatsapp.kind,
      ...(answered.value.whatsapp.kind === 'failed' && {
        whatsappError: answered.value.whatsapp.error,
      }),
    };
  }

  /** What was done in the console, the latest first; of one subject where `subject` names it. */
  @Get('actions')
  async actions(@Query('subject') subject?: string, @Query('first') first?: string) {
    const count = Number(first);
    return {
      actions: (
        await this.console.actions({
          subject: subject?.slice(0, 100) || null,
          first: Number.isInteger(count) ? count : 50,
        })
      ).map(actionJson),
    };
  }
}
