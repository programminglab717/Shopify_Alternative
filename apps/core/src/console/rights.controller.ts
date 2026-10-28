import { PublicSite } from '@hatti/api';
import { ProductService } from '@hatti/catalog/public';
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
  RIGHTS_LIMITS,
  RightsComplaintsService,
  type RightsComplaintRecord,
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
import { refuseRightsCounter, releaseRights, upholdRights } from '../rights.js';
import { consoleError } from './console.controller.js';
import { CONSOLE_DATABASE, consoleWords, notFound, shopOf, iso } from './trust.controller.js';

function complaintJson(complaint: RightsComplaintRecord, now: number) {
  return {
    id: toPublicId('rightsComplaint', complaint.id),
    shop: shopOf(complaint),
    kind: complaint.kind,
    rightsOwner: complaint.rightsOwner,
    registration: complaint.registration,
    complainant: complaint.complainant,
    actingAs: complaint.actingAs,
    email: complaint.email,
    phone: complaint.phone,
    listings: complaint.listings.map((listing) => ({
      id: toPublicId('product', listing.id),
      title: listing.title,
      url: listing.url,
    })),
    details: complaint.details,
    signature: complaint.signature,
    language: complaint.language,
    status: complaint.status,
    overdue: complaint.status === 'open' && complaint.dueAt.getTime() < now,
    dueAt: complaint.dueAt.toISOString(),
    createdAt: complaint.createdAt.toISOString(),
    decidedBy: complaint.decidedBy,
    decision: complaint.decision,
    counter: complaint.counteredAt
      ? {
          words: complaint.counterWords,
          signature: complaint.counterSignature,
          at: complaint.counteredAt.toISOString(),
          status: complaint.counterStatus,
          answer: complaint.counterAnswer,
          answeredBy: complaint.counterAnsweredBy,
        }
      : null,
    releasedAt: iso(complaint.releasedAt),
    releasedBy: complaint.releasedBy,
    releaseNote: complaint.releaseNote,
  };
}

/**
 * Rights complaints in the console (ADR-878), as `trust-reports` has them: owners' complaints of a
 * store's listings (ADR-474) dismissed, or upheld with the listings held off sale and the store's
 * owner told (ADR-475); the owner's answer refused, or the listings let go (ADR-476); and a
 * listing screening found by mistake cleared (ADR-473). Each logged before it is done.
 */
@Controller('console/api')
@UseGuards(ConsoleGuard)
@UseFilters(AuthErrorFilter)
export class ConsoleRightsController {
  readonly #rights: RightsComplaintsService;
  readonly #products: ProductService;
  readonly #messages: MessagesService;

  constructor(
    private readonly console: ConsoleAuthService,
    @Inject(CONSOLE_DATABASE) private readonly database: Database,
    private readonly site: PublicSite,
  ) {
    this.#rights = new RightsComplaintsService(database);
    this.#products = new ProductService(database);
    this.#messages = new MessagesService(database);
  }

  /** Complaints open, the soonest due first; or all, the latest first. */
  @Get('rights')
  async complaints(@Query('all') all?: string) {
    const now = Date.now();
    return {
      complaints: (await this.#rights.list({ all: all === '1' })).map((each) =>
        complaintJson(each, now),
      ),
    };
  }

  /** Store owners' answers waiting; or all. */
  @Get('rights-answers')
  async answers(@Query('all') all?: string) {
    const now = Date.now();
    return {
      complaints: (await this.#rights.counters({ all: all === '1' })).map((each) =>
        complaintJson(each, now),
      ),
    };
  }

  /** Dismisses a complaint, `{ note }`, which the complainant is written to with. */
  @Post('rights/:id/dismiss')
  @HttpCode(200)
  async dismiss(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const note = consoleWords(body, 'note', 1000, { message: 'Say why' });
    const complaint = this.#idOf(id);
    await this.console.record(agent, 'rights.dismiss', id);
    const decided = await this.#rights.decide(complaint, {
      status: 'dismissed',
      by: agent.name,
      note,
    });
    if (decided === 'not_found') throw notFound('rights complaint');
    if (decided === 'decided') throw consoleError(409, 'DECIDED', 'It was decided already');
    return { complaint: complaintJson(decided, Date.now()) };
  }

  /**
   * Upholds a complaint, `{ note }`, as its owner is told: the listings held off sale, and the
   * owner sent who complained and the link to answer by.
   */
  @Post('rights/:id/uphold')
  @HttpCode(200)
  async uphold(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const note = consoleWords(body, 'note', 1000, { message: 'Say why, as its owner is told' });
    const complaint = this.#idOf(id);
    await this.console.record(agent, 'rights.uphold', id);
    const upheld = await upholdRights(
      this.database,
      this.#rights,
      this.#products,
      this.#messages,
      this.site,
      complaint,
      { by: agent.name, note },
    );
    if (upheld === 'not_found') throw notFound('rights complaint');
    if (upheld === 'decided') throw consoleError(409, 'DECIDED', 'It was decided already');
    return { complaint: complaintJson(upheld.complaint, Date.now()), held: upheld.held.length };
  }

  /** Refuses the store owner's answer, `{ answer }`: the listings stay held, the owner told why. */
  @Post('rights/:id/refuse-answer')
  @HttpCode(200)
  async refuseAnswer(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const agent = consoleAgentOf(request);
    const answer = consoleWords(body, 'answer', RIGHTS_LIMITS.answer, {
      message: 'Say why, as its owner is told',
    });
    const complaint = this.#idOf(id);
    await this.console.record(agent, 'rights.refuse_answer', id);
    const refused = await refuseRightsCounter(
      this.database,
      this.#rights,
      this.#messages,
      complaint,
      {
        by: agent.name,
        answer,
      },
    );
    if (typeof refused === 'string') throw this.#problem(refused, 'No answer of its owner waits');
    return { complaint: complaintJson(refused, Date.now()) };
  }

  /** Lets the held listings go, `{ note }`, which upholds the owner's answer: the owner told. */
  @Post('rights/:id/release')
  @HttpCode(200)
  async release(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const note = consoleWords(body, 'note', 1000, { message: 'Say why, as its owner is told' });
    const complaint = this.#idOf(id);
    await this.console.record(agent, 'rights.release', id);
    const released = await releaseRights(
      this.database,
      this.#rights,
      this.#products,
      this.#messages,
      complaint,
      { by: agent.name, note },
    );
    if (typeof released === 'string') throw this.#problem(released, 'They were let go already');
    return {
      complaint: complaintJson(released.complaint, Date.now()),
      released: released.released,
    };
  }

  /**
   * Clears a listing the screening for goods Hatti doesn't allow found by mistake (ADR-473), for
   * its words as they are: it may go on sale until they change.
   */
  @Post('products/:id/clear-screening')
  @HttpCode(200)
  async clearScreening(@Param('id') id: string, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const product = tryFromPublicId(id, 'product');
    if (!product) throw notFound("product: name it by its ID, as the shop's admin shows it");
    await this.console.record(agent, 'product.clear_screening', id);
    const cleared = await this.#products.clearScreening(product);
    if (!cleared) throw notFound("product: name it by its ID, as the shop's admin shows it");
    return { product: { id, title: cleared.title, found: cleared.found } };
  }

  #idOf(id: string): string {
    const complaint = tryFromPublicId(id, 'rightsComplaint');
    if (!complaint) throw notFound('rights complaint');
    return complaint;
  }

  #problem(problem: 'not_found' | 'not_upheld' | 'answered', answered: string) {
    return problem === 'not_found'
      ? notFound('rights complaint')
      : problem === 'not_upheld'
        ? consoleError(409, 'NOT_UPHELD', 'It was not upheld: nothing is held for it')
        : consoleError(409, 'ANSWERED', answered);
  }
}
