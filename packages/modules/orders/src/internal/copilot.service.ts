import {
  AiGateway,
  COPILOT_LIMITS,
  readCopilotRequest,
  type CopilotReading,
  type DiscountDraft,
} from '@hatti/ai';
import {
  AiCredits,
  aiCreditsMessage,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SegmentQueryError, SegmentService } from '@hatti/customers/public';
import { Database, type Tx } from '@hatti/db';
import { pkDayOf } from '@hatti/pk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  CustomReportService,
  type CustomReportResult,
  type ReportBreakdown,
  type ReportPeriod,
} from './custom-reports.js';
import { reportChoicesOf } from './report-questions.js';

// The merchant copilot (AI-01, ADR-894): staff ask in English, Urdu or Roman Urdu, and the AI reads
// the request alone, with the segment fields and report choices, into a draft of a discount code,
// a customer segment or a report. Hatti checks the draft: a segment's query compiles and is
// counted, a report is run. Nothing is made here: staff confirm a discount or segment through
// the admin's own mutations. Fifty a day at most, each kept with what it cost; each draft spends
// an AI credit.

export const COPILOT_DAILY = 50;

/** A draft for staff to confirm, checked; a report already run. */
export type CopilotDraft =
  | { kind: 'discount'; discount: DiscountDraft }
  | { kind: 'segment'; name: string; query: string; customers: number }
  | {
      kind: 'report';
      breakdown: ReportBreakdown;
      columns: string[];
      period: ReportPeriod;
      report: CustomReportResult;
    };

@Injectable()
export class CopilotService {
  constructor(
    private readonly db: Database,
    private readonly segments: SegmentService,
    private readonly reports: CustomReportService,
    /** The AI gateway, where the host configured one (ADR-463): without it, no drafts. */
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
    /** The AI credits of the shop's plan (ADR-533); without them, drafts are not counted. */
    @Optional() @Inject(AiCredits) private readonly credits?: AiCredits | null,
  ) {}

  /** Whether the shop may ask, and how many it asked in the last day. */
  async asking(tenant: TenantContext, now: Date = new Date()) {
    const usedToday = await this.db.tenant(tenant.shopId, (tx) =>
      requestsSince(tx, tenant.shopId, now),
    );
    return { available: Boolean(this.ai), usedToday, limitPerDay: COPILOT_DAILY };
  }

  /**
   * The draft `request` asks for, checked, as of `now`; or why there is none: not one the
   * copilot drafts, a segment whose query does not check, the AI out of reach, or the day's
   * requests used up. `trueProfit` says whether the plan shows the lines of true profit.
   */
  async draft(
    tenant: TenantContext,
    request: string,
    trueProfit: boolean,
    now: Date = new Date(),
  ): Promise<MutationResult<CopilotDraft>> {
    const ai = this.ai;
    if (!ai) return failOne(['base'], 'UNAVAILABLE', "The copilot isn't set up here");
    const asked = request.trim();
    if (!asked) return failOne(['request'], 'BLANK', 'Say what to draft');
    if (asked.length > COPILOT_LIMITS.request) {
      return failOne(
        ['request'],
        'TOO_LONG',
        `Ask in ${COPILOT_LIMITS.request} characters at most`,
      );
    }
    const used = await this.db.tenant(tenant.shopId, (tx) => requestsSince(tx, tenant.shopId, now));
    if (used >= COPILOT_DAILY) {
      return failOne(
        ['base'],
        'TOO_MANY',
        `A shop may ask the copilot ${COPILOT_DAILY} times a day: try again tomorrow`,
      );
    }
    const balance = await this.credits?.balanceOf(tenant.shopId, now);
    if (balance && balance.left <= 0) {
      return failOne(['base'], 'TOO_MANY', aiCreditsMessage(balance));
    }
    const result = await readCopilotRequest(ai, asked, {
      segmentFields: this.segments
        .fields()
        .map(({ name, type, description, example }) => ({ name, type, description, example })),
      report: reportChoicesOf(trueProfit),
      today: pkDayOf(now),
    });
    const checked = result.ok ? await this.#check(tenant, result.value, trueProfit, now) : null;
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    const outcome = !result.ok
      ? result.reason
      : result.value.kind === 'none'
        ? 'none'
        : checked?.ok
          ? result.value.kind
          : 'unchecked';
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO orders.copilot_requests
          (shop_id, request, outcome, input_tokens, output_tokens, created_at)
        VALUES (${tenant.shopId}, ${asked}, ${outcome}, ${usage.inputTokens},
                ${usage.outputTokens}, ${now.toISOString()})`),
    );
    if (!result.ok) {
      return failOne(
        ['base'],
        'UNAVAILABLE',
        'The copilot could not read that just now: try again in a minute',
      );
    }
    if (result.value.kind === 'none') {
      return failOne(['request'], 'INVALID', result.value.reason);
    }
    if (!checked!.ok) return checked!;
    await this.credits?.spend(tenant.shopId, 'copilot', now);
    return checked!;
  }

  /** A reading checked into a draft: a segment compiled and counted, a report run. */
  async #check(
    tenant: TenantContext,
    reading: CopilotReading,
    trueProfit: boolean,
    now: Date,
  ): Promise<MutationResult<CopilotDraft> | null> {
    switch (reading.kind) {
      case 'none':
        return null;
      case 'discount':
        return { ok: true, value: reading };
      case 'segment':
        try {
          const customers = await this.segments.count(tenant, reading.query);
          return {
            ok: true,
            value: { kind: 'segment', name: reading.name, query: reading.query, customers },
          };
        } catch (error) {
          if (!(error instanceof SegmentQueryError)) throw error;
          return failOne(
            ['request'],
            'INVALID',
            'The copilot could not write that segment from the fields there are: say it ' +
              'another way, or make it on the segments page',
          );
        }
      case 'report': {
        const breakdown = reading.breakdown as ReportBreakdown;
        const period = reading.period as ReportPeriod;
        const ran = await this.reports.run(
          tenant,
          { breakdown, columns: reading.columns, period },
          trueProfit,
          now,
        );
        return ran.ok
          ? {
              ok: true,
              value: {
                kind: 'report',
                breakdown,
                columns: reading.columns,
                period,
                report: ran.value,
              },
            }
          : ran;
      }
    }
  }
}

/** How many requests the shop made of the copilot in the day before `now`. */
async function requestsSince(tx: Tx, shopId: string, now: Date): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM orders.copilot_requests
     WHERE shop_id = ${shopId}
       AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
  return rows[0]!.count;
}
