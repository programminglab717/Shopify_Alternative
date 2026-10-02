import { Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { EmailFeedbackService, type EmailFeedbackOutcome } from './email-feedback.js';

/** What SNS is answered: anything but a 2xx is sent again, for a while. */
const STATUS: Record<EmailFeedbackOutcome, number> = {
  not_found: 404,
  invalid: 403,
  unreachable: 503,
  confirmed: 200,
  recorded: 200,
  ignored: 200,
};

/**
 * SES's bounces and complaints, as SNS posts them (ADR-170). The host keeps each request's raw
 * body as `rawBody`: SNS sends it as text, the message it signed.
 */
@Controller('webhooks/ses')
export class EmailFeedbackController {
  constructor(private readonly feedback: EmailFeedbackService) {}

  @Post()
  async notify(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const outcome = await this.feedback.hear(raw ? raw.toString('utf8') : '');
    await reply.code(STATUS[outcome]).send();
  }
}
