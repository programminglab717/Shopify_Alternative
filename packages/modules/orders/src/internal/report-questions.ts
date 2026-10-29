import {
  AiGateway,
  REPORT_QUESTION_LIMITS,
  readReportQuestion,
  type ReportChoices,
} from '@hatti/ai';
import {
  AiCredits,
  aiCreditsMessage,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  CustomReportService,
  PRODUCT_REPORT_COLUMNS,
  REPORT_BREAKDOWNS,
  REPORT_PERIODS,
  SALES_REPORT_COLUMNS,
  STOCK_REPORT_COLUMNS,
  type CustomReportResult,
  type ReportBreakdown,
  type ReportPeriod,
} from './custom-reports.js';

// Questions of the shop's numbers (ANL-08, ADR-844): a merchant asks in English, Urdu or Roman
// Urdu; the AI reads the question alone into one of Hatti's reports (ADR-817), never seeing the
// shop's numbers; Hatti runs the report and shows it, with what it took the question to ask.
// Fifty a day at most, each kept with what it cost, and each answer spends an AI credit.

export const REPORT_QUESTION_DAILY = 50;

/** What a question was taken to ask, and the report that answers it. */
export interface ReportAnswer {
  breakdown: ReportBreakdown;
  columns: string[];
  period: ReportPeriod;
  report: CustomReportResult;
}

/** The lines of true profit, which only some plans show (ADR-529): never chosen without them. */
const TRUE_PROFIT_COLUMNS = new Set(
  Object.entries(SALES_REPORT_COLUMNS)
    .filter(([, column]) => column.trueProfit)
    .map(([key]) => key),
);

/** The reports a reading may choose among: the lines of true profit only where the plan shows them. */
export function reportChoicesOf(trueProfit: boolean): ReportChoices {
  return {
    breakdowns: REPORT_BREAKDOWNS,
    periods: REPORT_PERIODS,
    salesColumns: Object.keys(SALES_REPORT_COLUMNS).filter(
      (key) => trueProfit || !TRUE_PROFIT_COLUMNS.has(key),
    ),
    productColumns: Object.keys(PRODUCT_REPORT_COLUMNS),
    stockColumns: Object.keys(STOCK_REPORT_COLUMNS),
  };
}

@Injectable()
export class ReportQuestionService {
  constructor(
    private readonly db: Database,
    private readonly reports: CustomReportService,
    /** The AI gateway, where the host configured one (ADR-463): without it, no answers. */
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
    /** The AI credits of the shop's plan (ADR-533); without them, answers are not counted. */
    @Optional() @Inject(AiCredits) private readonly credits?: AiCredits | null,
  ) {}

  /** Whether the shop may ask, and how many it asked in the last day. */
  async asking(tenant: TenantContext, now: Date = new Date()) {
    const usedToday = await this.db.tenant(tenant.shopId, (tx) =>
      asksSince(tx, tenant.shopId, now),
    );
    return { available: Boolean(this.ai), usedToday, limitPerDay: REPORT_QUESTION_DAILY };
  }

  /**
   * The report that answers `question`, as of `now`; or why there is none: not a question of the
   * shop's numbers, the AI out of reach, or the day's asks used up. `trueProfit` says whether the
   * plan shows the lines of true profit.
   */
  async ask(
    tenant: TenantContext,
    question: string,
    trueProfit: boolean,
    now: Date = new Date(),
  ): Promise<MutationResult<ReportAnswer>> {
    const ai = this.ai;
    if (!ai) return failOne(['base'], 'UNAVAILABLE', "AI answers aren't set up here");
    const asked = question.trim();
    if (!asked) return failOne(['question'], 'BLANK', 'Ask a question of your numbers');
    if (asked.length > REPORT_QUESTION_LIMITS.question) {
      return failOne(
        ['question'],
        'TOO_LONG',
        `Ask in ${REPORT_QUESTION_LIMITS.question} characters at most`,
      );
    }
    const used = await this.db.tenant(tenant.shopId, (tx) => asksSince(tx, tenant.shopId, now));
    if (used >= REPORT_QUESTION_DAILY) {
      return failOne(
        ['base'],
        'TOO_MANY',
        `A shop may ask ${REPORT_QUESTION_DAILY} questions a day: try again tomorrow`,
      );
    }
    const balance = await this.credits?.balanceOf(tenant.shopId, now);
    if (balance && balance.left <= 0) {
      return failOne(['base'], 'TOO_MANY', aiCreditsMessage(balance));
    }
    const result = await readReportQuestion(ai, asked, reportChoicesOf(trueProfit));
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    const reading = result.ok && result.value.answerable ? result.value : null;
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO orders.report_questions
          (shop_id, question, outcome, breakdown, period, columns, input_tokens, output_tokens,
           created_at)
        VALUES (${tenant.shopId}, ${asked},
                ${result.ok ? (reading ? 'answered' : 'unanswerable') : result.reason},
                ${reading?.breakdown ?? null}, ${reading?.period ?? null},
                ${sql.param(reading?.columns ?? [])}::text[],
                ${usage.inputTokens}, ${usage.outputTokens}, ${now.toISOString()})`),
    );
    if (!result.ok) {
      return failOne(
        ['base'],
        'UNAVAILABLE',
        'The AI could not read your question just now: try again in a minute',
      );
    }
    if (!result.value.answerable) {
      return failOne(['question'], 'INVALID', result.value.reason);
    }
    const breakdown = result.value.breakdown as ReportBreakdown;
    const period = result.value.period as ReportPeriod;
    const ran = await this.reports.run(
      tenant,
      { breakdown, columns: result.value.columns, period },
      trueProfit,
      now,
    );
    if (!ran.ok) return ran;
    await this.credits?.spend(tenant.shopId, 'report_question', now);
    return {
      ok: true,
      value: { breakdown, columns: result.value.columns, period, report: ran.value },
    };
  }
}

/** How many questions the shop asked in the day before `now`. */
async function asksSince(tx: Tx, shopId: string, now: Date): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM orders.report_questions
     WHERE shop_id = ${shopId}
       AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
  return rows[0]!.count;
}
