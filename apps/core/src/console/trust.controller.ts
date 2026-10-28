import { PublicSite } from '@hatti/api';
import type { Database } from '@hatti/db';
import {
  AuthErrorFilter,
  ConsoleAuthService,
  ConsoleGuard,
  consoleAgentOf,
} from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { MessagesService } from '@hatti/messaging/public';
import {
  APPEAL_LIMITS,
  AppealsService,
  REPORT_REASONS,
  ReportsService,
  TAKEDOWN_LIMITS,
  TakedownsService,
  VERIFICATION_LIMITS,
  VerificationsService,
  type AppealRecord,
  type ReportRecord,
  type TakedownRecord,
  type VerificationReview,
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
import { refuseAppeal, restoreStore, takeDown } from '../takedowns.js';
import { approveVerification, refuseVerification, revokeVerification } from '../verifications.js';
import { consoleError } from './console.controller.js';

/** The database, with the system login, as the console's server has it. */
export const CONSOLE_DATABASE = Symbol('CONSOLE_DATABASE');

export const iso = (at: Date | null) => at?.toISOString() ?? null;
export const shopOf = (record: { shopId: string; shopName: string; shopHandle: string }) => ({
  id: toPublicId('shop', record.shopId),
  name: record.shopName,
  handle: record.shopHandle,
});

function reportJson(report: ReportRecord, now: number) {
  return {
    id: toPublicId('storeReport', report.id),
    shop: shopOf(report),
    openOfShop: report.openOfShop,
    reason: report.reason,
    details: report.details,
    phone: report.phone,
    orderName: report.orderName,
    pageUrl: report.pageUrl,
    language: report.language,
    status: report.status,
    overdue: report.status === 'open' && report.dueAt.getTime() < now,
    dueAt: report.dueAt.toISOString(),
    createdAt: report.createdAt.toISOString(),
    decidedAt: iso(report.decidedAt),
    decidedBy: report.decidedBy,
    decision: report.decision,
  };
}

function takedownJson(takedown: TakedownRecord) {
  return {
    shop: shopOf(takedown),
    reason: takedown.reason,
    note: takedown.note,
    takenBy: takedown.takenBy,
    createdAt: takedown.createdAt.toISOString(),
    restoredAt: iso(takedown.restoredAt),
    restoredBy: takedown.restoredBy,
    restoreNote: takedown.restoreNote,
  };
}

function appealJson(appeal: AppealRecord) {
  return {
    id: toPublicId('storeAppeal', appeal.id),
    shop: shopOf(appeal),
    reason: appeal.reason,
    takedownNote: appeal.takedownNote,
    words: appeal.words,
    status: appeal.status,
    createdAt: appeal.createdAt.toISOString(),
    answeredAt: iso(appeal.answeredAt),
    answeredBy: appeal.answeredBy,
    answer: appeal.answer,
  };
}

function verificationJson(review: VerificationReview) {
  return {
    id: toPublicId('verification', review.id),
    shop: shopOf(review),
    level: review.level,
    name: review.name,
    // In full while it waits; its last four once decided.
    cnic: review.cnic,
    cnicLast4: review.cnicLast4,
    ntn: review.ntn,
    status: review.status,
    documents: review.documents.length,
    createdAt: review.createdAt.toISOString(),
    decidedAt: iso(review.decidedAt),
    decidedBy: review.decidedBy,
    answer: review.answer,
  };
}

/** A field of the body: its words, trimmed, required unless said, at most `max` characters. */
export function consoleWords(
  body: unknown,
  name: string,
  max: number,
  options: { required?: boolean; message?: string } = {},
): string {
  const value = (body as Record<string, unknown> | null)?.[name];
  const words = typeof value === 'string' ? value.trim() : '';
  if (!words && options.required !== false) {
    throw consoleError(422, 'BLANK', options.message ?? 'Say why', { [name]: 'BLANK' });
  }
  if (words.length > max) {
    throw consoleError(422, 'TOO_LONG', `At most ${max} characters`, { [name]: 'TOO_LONG' });
  }
  return words;
}

export const notFound = (what: string) => consoleError(404, 'NOT_FOUND', `No such ${what}`);
const already = (message: string) => consoleError(409, 'DECIDED', message);

/**
 * Hatti's people's trust queues in the console (ADR-877), as `trust-reports` has them for whoever
 * runs Hatti: shoppers' reports of stores (ADR-460), stores taken down and restored (ADR-461),
 * their owners' appeals (ADR-462), and shops' verifications (ADR-465). Each decision is written
 * down before it is made, and the shop told as the command tells it.
 */
@Controller('console/api')
@UseGuards(ConsoleGuard)
@UseFilters(AuthErrorFilter)
export class ConsoleTrustController {
  readonly #reports: ReportsService;
  readonly #takedowns: TakedownsService;
  readonly #appeals: AppealsService;
  readonly #messages: MessagesService;

  constructor(
    private readonly console: ConsoleAuthService,
    @Inject(CONSOLE_DATABASE) private readonly database: Database,
    private readonly verifications: VerificationsService,
    private readonly site: PublicSite,
  ) {
    this.#reports = new ReportsService(database);
    this.#takedowns = new TakedownsService(database);
    this.#appeals = new AppealsService(database);
    this.#messages = new MessagesService(database);
  }

  /** Reports open, the soonest due first; or all, the latest first. */
  @Get('reports')
  async reports(@Query('all') all?: string) {
    const now = Date.now();
    return {
      reports: (await this.#reports.list({ all: all === '1' })).map((each) =>
        reportJson(each, now),
      ),
    };
  }

  /** A report dismissed, or upheld with what was done: `{ status, note }`. */
  @Post('reports/:id/decide')
  @HttpCode(200)
  async decide(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const status = (body as { status?: unknown } | null)?.status;
    if (status !== 'dismissed' && status !== 'upheld') {
      throw consoleError(422, 'INVALID', 'Dismiss it or uphold it', { status: 'INVALID' });
    }
    const note = consoleWords(body, 'note', 1000, {
      message: status === 'upheld' ? 'Say what was done' : 'Say why',
    });
    const report = tryFromPublicId(id, 'storeReport');
    if (!report) throw notFound('report');
    await this.console.record(agent, `report.${status === 'upheld' ? 'uphold' : 'dismiss'}`, id);
    const decided = await this.#reports.decide(report, { status, by: agent.name, note });
    if (decided === 'not_found') throw notFound('report');
    if (decided === 'decided') throw already('It was decided already');
    return { report: reportJson(decided, Date.now()) };
  }

  /** Stores down, the latest first; or every takedown. */
  @Get('takedowns')
  async takedownsList(@Query('all') all?: string) {
    return { takedowns: (await this.#takedowns.list({ all: all === '1' })).map(takedownJson) };
  }

  /**
   * Takes the store `handle` down, `{ reason, note }`: its owner told why first, with the link to
   * appeal by, its storefront then saying it is down.
   */
  @Post('shops/:handle/suspend')
  @HttpCode(200)
  async suspend(
    @Param('handle') handle: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const agent = consoleAgentOf(request);
    const reason = (body as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) {
      throw consoleError(422, 'INVALID', 'Say why it is taken down', { reason: 'INVALID' });
    }
    const note = consoleWords(body, 'note', TAKEDOWN_LIMITS.note, {
      message: 'Say why, as its owner is told',
    });
    await this.console.record(agent, 'store.suspend', handle.slice(0, 100), { reason });
    const done = await takeDown(this.database, this.#takedowns, this.#messages, this.site, handle, {
      reason,
      note,
      by: agent.name,
    });
    if (done === 'not_found') throw notFound('shop: name it by its handle');
    if (typeof done === 'string') throw already('Only an open store is taken down');
    return { takedown: takedownJson(done) };
  }

  /** Restores the store `handle`, `{ note }`, its owner told why; the appeal waiting upheld. */
  @Post('shops/:handle/restore')
  @HttpCode(200)
  async restore(
    @Param('handle') handle: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const agent = consoleAgentOf(request);
    const note = consoleWords(body, 'note', TAKEDOWN_LIMITS.note, {
      message: 'Say why, as its owner is told',
    });
    await this.console.record(agent, 'store.restore', handle.slice(0, 100));
    const done = await restoreStore(this.database, this.#takedowns, this.#messages, handle, {
      note,
      by: agent.name,
    });
    if (done === 'not_found') throw notFound('shop: name it by its handle');
    if (typeof done === 'string') throw already('That store is not down');
    return { takedown: takedownJson(done) };
  }

  /** Appeals waiting, the oldest first; or all, the latest first. */
  @Get('appeals')
  async appealsList(@Query('all') all?: string) {
    return { appeals: (await this.#appeals.list({ all: all === '1' })).map(appealJson) };
  }

  /** Refuses an appeal waiting, `{ answer }`: its link's page shows why, and the owner is told. */
  @Post('appeals/:id/refuse')
  @HttpCode(200)
  async refuse(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const answer = consoleWords(body, 'answer', APPEAL_LIMITS.answer, {
      message: 'Say why, as its owner is told',
    });
    const appeal = tryFromPublicId(id, 'storeAppeal');
    if (!appeal) throw notFound('appeal');
    await this.console.record(agent, 'appeal.refuse', id);
    const refused = await refuseAppeal(this.database, this.#appeals, this.#messages, appeal, {
      by: agent.name,
      answer,
    });
    if (refused === 'not_found') throw notFound('appeal');
    if (refused === 'answered') throw already('It was answered already');
    return { appeal: appealJson(refused) };
  }

  /** Verifications waiting, the oldest first; or all, the latest first. */
  @Get('verifications')
  async verificationsList(@Query('all') all?: string) {
    return {
      verifications: (await this.verifications.list({ all: all === '1' })).map(verificationJson),
    };
  }

  /**
   * Links to a waiting verification's documents, for an hour: the CNIC's or the NTN's photos.
   * Each look is written down first.
   */
  @Get('verifications/:id/documents')
  async documents(@Param('id') id: string, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const verification = tryFromPublicId(id, 'verification');
    const review = verification
      ? (await this.verifications.list()).find((each) => each.id === verification)
      : undefined;
    if (!review) throw notFound('verification waiting');
    await this.console.record(agent, 'verification.documents', id);
    return { links: this.verifications.documentLinks(review) };
  }

  /** Approves a verification waiting, `{ answer? }`, a note the shop reads: its documents deleted, the shop told. */
  @Post('verifications/:id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const note = consoleWords(body, 'answer', VERIFICATION_LIMITS.answer, { required: false });
    return this.#decideVerification(agent, id, 'approve', () =>
      approveVerification(
        this.database,
        this.verifications,
        this.#messages,
        tryFromPublicId(id, 'verification')!,
        { by: agent.name, note },
      ),
    );
  }

  /** Refuses a verification waiting, `{ answer }`, which its owner reads; its documents deleted. */
  @Post('verifications/:id/refuse')
  @HttpCode(200)
  async refuseOne(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const answer = consoleWords(body, 'answer', VERIFICATION_LIMITS.answer, {
      message: 'Say why, as the shop is told',
    });
    return this.#decideVerification(agent, id, 'refuse', () =>
      refuseVerification(
        this.database,
        this.verifications,
        this.#messages,
        tryFromPublicId(id, 'verification')!,
        { by: agent.name, answer },
      ),
    );
  }

  /** Takes back the shop `handle`'s verification, `{ level, answer }`: a business's with its owner's. */
  @Post('shops/:handle/unverify')
  @HttpCode(200)
  async unverify(
    @Param('handle') handle: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const agent = consoleAgentOf(request);
    const level = (body as { level?: unknown } | null)?.level;
    if (level !== 'identity' && level !== 'business') {
      throw consoleError(422, 'INVALID', 'Say which: the owner or the business', {
        level: 'INVALID',
      });
    }
    const answer = consoleWords(body, 'answer', VERIFICATION_LIMITS.answer, {
      message: 'Say why, as the shop is told',
    });
    await this.console.record(agent, 'verification.revoke', handle.slice(0, 100), { level });
    const revoked = await revokeVerification(
      this.database,
      this.verifications,
      this.#messages,
      handle,
      level,
      { by: agent.name, answer },
    );
    if (revoked === 'not_found') throw notFound('shop: name it by its handle');
    if (revoked === 'not_verified') throw already('It is not verified at that level');
    return { verifications: revoked.map(verificationJson) };
  }

  async #decideVerification(
    agent: ReturnType<typeof consoleAgentOf>,
    id: string,
    action: 'approve' | 'refuse',
    decide: () => ReturnType<typeof approveVerification>,
  ) {
    if (!tryFromPublicId(id, 'verification')) throw notFound('verification');
    await this.console.record(agent, `verification.${action}`, id);
    const decided = await decide();
    if (decided === 'not_found') throw notFound('verification');
    if (decided === 'decided') throw already('It was decided already');
    if (decided === 'needs_identity') {
      throw consoleError(409, 'NEEDS_IDENTITY', "Its owner isn't verified: verify the owner first");
    }
    return { verification: verificationJson(decided) };
  }
}
