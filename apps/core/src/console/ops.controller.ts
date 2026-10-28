import { PublicSite } from '@hatti/api';
import {
  BILLING_CURRENCY,
  BillingService,
  StatementError,
  TRANSFER_REFUSAL_LENGTH,
  matchStatement,
  type StatementCredit,
  type TransferChecked,
  type WaitingTransferRecord,
} from '@hatti/billing/public';
import type { Database } from '@hatti/db';
import {
  AuthErrorFilter,
  ConsoleAuthService,
  ConsoleGuard,
  consoleAgentOf,
} from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { formatMoney, fromMajor, money } from '@hatti/money';
import {
  INCIDENT_IMPACTS,
  INCIDENT_KINDS,
  INCIDENT_LIMITS,
  IncidentsService,
  type IncidentRecord,
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
import { consoleError } from './console.controller.js';
import { CONSOLE_DATABASE, consoleWords, iso, notFound } from './trust.controller.js';

const rupees = (paisa: bigint) => formatMoney(money(paisa, BILLING_CURRENCY));

function transferJson(transfer: WaitingTransferRecord) {
  return {
    id: toPublicId('billingTransfer', transfer.id),
    shop: { id: toPublicId('shop', transfer.shopId), name: transfer.shopName },
    invoiceName: transfer.invoiceName,
    reference: transfer.reference,
    amount: rupees(transfer.amount),
    reportedAt: transfer.reportedAt.toISOString(),
  };
}

function creditJson(credit: StatementCredit) {
  return {
    row: credit.row,
    date: credit.date,
    description: credit.description,
    amount: rupees(credit.amount),
    /** What came, as the confirm call takes it: "2999.00". */
    received: `${credit.amount / 100n}.${String(credit.amount % 100n).padStart(2, '0')}`,
  };
}

/** The most credits nothing matched that the console is shown. */
const UNMATCHED_SHOWN = 50;

function checkedJson(checked: TransferChecked) {
  return { outcome: checked.outcome, invoiceName: checked.invoiceName, left: rupees(checked.left) };
}

function incidentJson(incident: IncidentRecord) {
  return {
    id: toPublicId('incident', incident.id),
    kind: incident.kind,
    impact: incident.impact,
    components: incident.components,
    title: incident.title,
    titleUr: incident.titleUr,
    status: incident.status,
    startsAt: incident.startsAt.toISOString(),
    endsAt: iso(incident.endsAt),
    resolvedAt: iso(incident.resolvedAt),
    createdBy: incident.createdBy,
    updates: incident.updates.map((update) => ({
      status: update.status,
      body: update.body,
      bodyUr: update.bodyUr,
      postedBy: update.postedBy,
      postedAt: update.postedAt.toISOString(),
    })),
  };
}

/** A field of the body that is text, or nothing. */
function optionalText(body: unknown, name: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** One of `allowed`, as the body gives it; refused otherwise. */
function oneOf<T extends string>(
  body: unknown,
  name: string,
  allowed: readonly T[],
  message: string,
): T {
  const value = (body as Record<string, unknown> | null)?.[name];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw consoleError(422, 'INVALID', message, { [name]: 'INVALID' });
  }
  return value as T;
}

/** A time the body gives, or nothing; refused when it isn't one. */
function optionalTime(body: unknown, name: string): Date | null {
  const value = optionalText(body, name);
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw consoleError(422, 'INVALID', 'Give a date and time', { [name]: 'INVALID' });
  }
  return at;
}

/**
 * Hatti's own operations in the console (ADR-879), as their commands have them: shops' transfers
 * into Hatti's bank account (ADR-254) confirmed or refused, and the status page's incidents and
 * maintenance (ADR-498) posted and updated. Each logged before it is done.
 */
@Controller('console/api')
@UseGuards(ConsoleGuard)
@UseFilters(AuthErrorFilter)
export class ConsoleOpsController {
  readonly #billing: BillingService;
  readonly #incidents: IncidentsService;

  constructor(
    private readonly console: ConsoleAuthService,
    @Inject(CONSOLE_DATABASE) database: Database,
    site: PublicSite,
  ) {
    this.#billing = new BillingService(database, site);
    this.#incidents = new IncidentsService(database);
  }

  /** Transfers shops said they made, waiting to be found in Hatti's account, the oldest first. */
  @Get('billing-transfers')
  async transfers() {
    return { transfers: (await this.#billing.waitingTransfers()).map(transferJson) };
  }

  /**
   * Confirms a transfer found, `{ received? }`, in rupees where it wasn't what the shop said: its
   * invoice paid, or waiting for the rest.
   */
  @Post('billing-transfers/:id/confirm')
  @HttpCode(200)
  async confirm(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const given = optionalText(body, 'received');
    let received: bigint | null = null;
    if (given) {
      try {
        received = fromMajor(given, BILLING_CURRENCY).amount;
      } catch {
        received = 0n;
      }
      if (received <= 0n) {
        throw consoleError(422, 'INVALID', 'Give what came, in rupees', { received: 'INVALID' });
      }
    }
    const transfer = tryFromPublicId(id, 'billingTransfer');
    if (!transfer) throw notFound('transfer');
    await this.console.record(agent, 'billing_transfer.confirm', id, {
      ...(given && { received: given }),
    });
    return this.#checked(
      await this.#billing.confirmTransfer(transfer, { by: agent.name, received }),
    );
  }

  /**
   * Hatti's bank statement, `{ csv }` as the bank exports it, matched against the transfers
   * waiting (ADR-883): each credit carrying a transfer's reference paired with it, for Hatti's
   * people to confirm; nothing is confirmed here.
   */
  @Post('billing-transfers/statement')
  @HttpCode(200)
  async statement(@Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const csv = (body as { csv?: unknown } | null)?.csv;
    if (typeof csv !== 'string' || !csv.trim()) {
      throw consoleError(422, 'BLANK', 'Choose the statement, as CSV', { csv: 'BLANK' });
    }
    const waiting = await this.#billing.waitingTransfers(500);
    let result;
    try {
      result = matchStatement(
        csv,
        waiting.map((each) => ({ id: each.id, reference: each.reference, amount: each.amount })),
      );
    } catch (error) {
      if (error instanceof StatementError) throw consoleError(422, 'INVALID', error.message);
      throw error;
    }
    await this.console.record(agent, 'billing_transfer.statement', null, {
      credits: result.credits,
      matched: result.matches.length,
    });
    const byId = new Map(waiting.map((each) => [each.id, each]));
    return {
      credits: result.credits,
      matches: result.matches.map((match) => ({
        transfer: transferJson(byId.get(match.transferId)!),
        credit: creditJson(match.credit),
        outcome: match.outcome,
      })),
      ambiguous: result.ambiguous.map((id) => transferJson(byId.get(id)!)),
      unmatched: result.unmatched.slice(0, UNMATCHED_SHOWN).map(creditJson),
      moreUnmatched: Math.max(0, result.unmatched.length - UNMATCHED_SHOWN),
    };
  }

  /** Refuses a transfer not found, `{ reason }`, which the shop's owner is told. */
  @Post('billing-transfers/:id/refuse')
  @HttpCode(200)
  async refuse(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const reason = consoleWords(body, 'reason', TRANSFER_REFUSAL_LENGTH, {
      message: "Say why: the shop's owner is told",
    });
    const transfer = tryFromPublicId(id, 'billingTransfer');
    if (!transfer) throw notFound('transfer');
    await this.console.record(agent, 'billing_transfer.refuse', id);
    return this.#checked(await this.#billing.refuseTransfer(transfer, { by: agent.name, reason }));
  }

  /** Incidents and maintenance going on or ahead; or all, those ended too. */
  @Get('incidents')
  async incidents(@Query('all') all?: string) {
    return { incidents: (await this.#incidents.list({ all: all === '1' })).map(incidentJson) };
  }

  /**
   * Posts an incident as it begins, or maintenance ahead of time: `{ kind, impact, components,
   * title, titleUr?, body, bodyUr?, startsAt?, endsAt? }`. The status page and every admin show it.
   */
  @Post('incidents')
  @HttpCode(200)
  async open(@Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const fields = (body ?? {}) as Record<string, unknown>;
    const kind = oneOf(
      body,
      'kind',
      INCIDENT_KINDS,
      'Say whether it is an incident or maintenance',
    );
    const impact = oneOf(body, 'impact', INCIDENT_IMPACTS, 'Say how badly it works');
    const title = consoleWords(body, 'title', INCIDENT_LIMITS.title, {
      message: 'Give it a title',
    });
    const note = consoleWords(body, 'body', INCIDENT_LIMITS.body, {
      message: 'Say what Hatti says',
    });
    const startsAt = optionalTime(body, 'startsAt');
    const endsAt = optionalTime(body, 'endsAt');
    await this.console.record(agent, 'incident.open', null, { title });
    const opened = await this.#incidents.open({
      kind,
      impact,
      components: Array.isArray(fields.components) ? fields.components.map(String) : [],
      title,
      titleUr: optionalText(body, 'titleUr'),
      body: note,
      bodyUr: optionalText(body, 'bodyUr'),
      startsAt,
      endsAt,
      by: agent.name,
    });
    if (!opened.ok) throw consoleError(422, 'INVALID', opened.problem);
    return { incident: incidentJson(opened.value) };
  }

  /** Updates an incident, `{ status, body, bodyUr?, impact?, components? }`: the last status ends it. */
  @Post('incidents/:id/update')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const fields = (body ?? {}) as Record<string, unknown>;
    const note = consoleWords(body, 'body', INCIDENT_LIMITS.body, {
      message: 'Say what Hatti says',
    });
    const incident = tryFromPublicId(id, 'incident');
    if (!incident) throw notFound('incident');
    await this.console.record(agent, 'incident.update', id, { status: fields.status });
    const updated = await this.#incidents.update(incident, {
      status: typeof fields.status === 'string' ? fields.status : '',
      body: note,
      bodyUr: optionalText(body, 'bodyUr'),
      impact: optionalText(body, 'impact')
        ? oneOf(body, 'impact', INCIDENT_IMPACTS, 'Say how badly it works')
        : null,
      components: Array.isArray(fields.components) ? fields.components.map(String) : null,
      by: agent.name,
    });
    if (updated === 'not_found') throw notFound('incident');
    if (!updated.ok) throw consoleError(422, 'INVALID', updated.problem);
    return { incident: incidentJson(updated.value) };
  }

  #checked(checked: TransferChecked | 'checked' | 'not_found') {
    if (checked === 'not_found') throw notFound('transfer');
    if (checked === 'checked') {
      throw consoleError(409, 'CHECKED', 'It was confirmed or refused already');
    }
    return { transfer: checkedJson(checked) };
  }
}
