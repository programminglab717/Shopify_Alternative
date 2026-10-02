import {
  BadRequestException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PAYMENT_WEBHOOK_PATH } from './gateway-accounts.service.js';
import { OnlinePaymentService } from './online-payment.service.js';

/**
 * Payment gateways' webhooks (ADR-151), one address an account, which staff add in the
 * gateway's dashboard: a payment the gateway says is made, signed with the account's secret, is
 * recorded on its session and its order, once. The host keeps each request's raw body as
 * `rawBody`, which the signature covers. Gateways send again what was not taken.
 */
@Controller(PAYMENT_WEBHOOK_PATH)
export class PaymentWebhookController {
  constructor(private readonly payments: OnlinePaymentService) {}

  @Post(':accountId')
  @HttpCode(200)
  async receive(
    @Param('accountId') accountId: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ): Promise<{ received: boolean }> {
    if (!request.rawBody) throw new BadRequestException('The request has no body');
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    const outcome = await this.payments.webhook(accountId, { body: request.rawBody, headers });
    if (outcome === 'not_found') throw new NotFoundException('No such payment gateway account');
    if (outcome === 'unsigned') {
      throw new UnauthorizedException("The request is not signed with the account's secret");
    }
    return { received: outcome === 'paid' };
  }
}
