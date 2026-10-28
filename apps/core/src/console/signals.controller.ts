import type { Database } from '@hatti/db';
import {
  AuthErrorFilter,
  ConsoleAuthService,
  ConsoleGuard,
  consoleAgentOf,
} from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  MessagesService,
  SMS_SENDER_LIMITS,
  SmsSendersService,
  type SmsSenderReview,
} from '@hatti/messaging/public';
import {
  SIGNAL_KINDS,
  SIGNAL_LIMITS,
  StoreSignalsService,
  type SignalKind,
  type StoreSignalRecord,
} from '@hatti/trust/public';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { approveSmsSender, refuseSmsSender, revokeSmsSender } from '../sms-senders.js';
import { consoleError } from './console.controller.js';
import { CONSOLE_DATABASE, consoleWords, iso, notFound, shopOf } from './trust.controller.js';

function signalJson(signal: StoreSignalRecord) {
  return {
    shop: shopOf(signal),
    kind: signal.kind,
    detail: signal.detail,
    firstSeenAt: signal.firstSeenAt.toISOString(),
    lastSeenAt: signal.lastSeenAt.toISOString(),
    clearedAt: iso(signal.clearedAt),
    clearedBy: signal.clearedBy,
    note: signal.note,
  };
}

function senderJson(sender: SmsSenderReview) {
  return {
    id: toPublicId('smsSender', sender.id),
    shop: shopOf(sender),
    name: sender.name,
    status: sender.status,
    createdAt: sender.createdAt.toISOString(),
    decidedAt: iso(sender.decidedAt),
    decidedBy: sender.decidedBy,
    answer: sender.answer,
  };
}

const SENDER_PROBLEMS: Record<string, [number, string]> = {
  decided: [409, 'It was decided already'],
  taken: [409, 'Another shop sends from that name'],
  not_verified: [409, "Hatti hasn't verified the shop: its sender waits for that"],
  not_approved: [409, 'The shop has no name of its own'],
};

/**
 * Signs of scam stores (ADR-842) and shops' own SMS sender names (ADR-469) in the console
 * (ADR-878), as `trust-reports` has them: a sign looked into and found to be nothing cleared, not
 * raised again; a name operators registered approved, or refused with why, or taken back. Each
 * logged before it is done, and the shop told of its sender as the command tells it.
 */
@Controller('console/api')
@UseGuards(ConsoleGuard)
@UseFilters(AuthErrorFilter)
export class ConsoleSignalsController {
  readonly #signals: StoreSignalsService;
  readonly #senders: SmsSendersService;
  readonly #messages: MessagesService;

  constructor(
    private readonly console: ConsoleAuthService,
    @Inject(CONSOLE_DATABASE) private readonly database: Database,
  ) {
    this.#signals = new StoreSignalsService(database);
    this.#senders = new SmsSendersService(database);
    this.#messages = new MessagesService(database);
  }

  /** Signs standing, found by the worker each day; or all, cleared ones too. */
  @Get('signals')
  async signals(@Query('all') all?: string) {
    return { signals: (await this.#signals.list({ all: all === '1' })).map(signalJson) };
  }

  /** Clears the sign `kind` of the store `handle`, `{ note }`: it is nothing, and isn't raised again. */
  @Post('shops/:handle/signals/:kind/clear')
  @HttpCode(200)
  async clear(
    @Param('handle') handle: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const agent = consoleAgentOf(request);
    if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) throw notFound('sign');
    const note = consoleWords(body, 'note', SIGNAL_LIMITS.note, {
      message: 'Say why it is nothing',
    });
    await this.console.record(agent, 'signal.clear', handle.slice(0, 100), { kind });
    if (!(await this.#signals.clear(handle, kind as SignalKind, agent.name, note))) {
      throw notFound(`${kind} standing for ${handle}`);
    }
    return { cleared: true };
  }

  /** Sender names waiting, the oldest first; or all. */
  @Get('sms-senders')
  async senders(@Query('all') all?: string) {
    return { senders: (await this.#senders.list({ all: all === '1' })).map(senderJson) };
  }

  /** Approves a name operators registered, `{ answer? }`, a note: the shop's SMS go from it. */
  @Post('sms-senders/:id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const note = consoleWords(body, 'answer', SMS_SENDER_LIMITS.answer, { required: false });
    const sender = this.#idOf(id);
    await this.console.record(agent, 'sms_sender.approve', id);
    return this.#done(
      await approveSmsSender(this.database, this.#senders, this.#messages, sender, {
        by: agent.name,
        note,
      }),
    );
  }

  /** Refuses a name, `{ answer }`, as the shop is told. */
  @Post('sms-senders/:id/refuse')
  @HttpCode(200)
  async refuse(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const answer = consoleWords(body, 'answer', SMS_SENDER_LIMITS.answer, {
      message: 'Say why, as the shop is told',
    });
    const sender = this.#idOf(id);
    await this.console.record(agent, 'sms_sender.refuse', id);
    return this.#done(
      await refuseSmsSender(this.database, this.#senders, this.#messages, sender, {
        by: agent.name,
        answer,
      }),
    );
  }

  /** Takes back the name the store `handle` sends from, `{ answer }`, as the shop is told. */
  @Post('shops/:handle/sms-sender/revoke')
  @HttpCode(200)
  async revoke(
    @Param('handle') handle: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const agent = consoleAgentOf(request);
    const answer = consoleWords(body, 'answer', SMS_SENDER_LIMITS.answer, {
      message: 'Say why, as the shop is told',
    });
    await this.console.record(agent, 'sms_sender.revoke', handle.slice(0, 100));
    const revoked = await revokeSmsSender(this.database, this.#senders, this.#messages, handle, {
      by: agent.name,
      answer,
    });
    if (revoked === 'not_found') throw notFound('shop: name it by its handle');
    return this.#done(revoked);
  }

  #idOf(id: string): string {
    const sender = tryFromPublicId(id, 'smsSender');
    if (!sender) throw notFound('sender name');
    return sender;
  }

  #done(done: SmsSenderReview | string) {
    if (typeof done !== 'string') return { sender: senderJson(done) };
    if (done === 'not_found') throw notFound('sender name');
    const [status, message] = SENDER_PROBLEMS[done] ?? [409, 'It can’t be done'];
    throw consoleError(status, done.toUpperCase(), message);
  }
}
