import {
  CurrentTenant,
  PlanAllowance,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { Inject, Optional } from '@nestjs/common';
import { Args, Field, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { REPORT_QUESTION_DAILY, ReportQuestionService } from '../report-questions.js';
import { toReportResult } from './custom-report.resolver.js';
import {
  CustomReportBreakdown,
  CustomReportPeriod,
  CustomReportResult,
} from './custom-report.types.js';

@ObjectType({ description: 'Asking questions of the shop’s numbers (ANL-08, ADR-844).' })
export class ReportQuestions {
  @Field({ description: 'Whether Hatti answers: false until its AI is set up.' })
  available!: boolean;

  @Field(() => Int)
  usedToday!: number;

  @Field(() => Int)
  limitPerDay!: number;
}

@ObjectType({
  description:
    'The report that answers a question, with what the question was taken to ask: its rows, ' +
    'columns and period, as a custom report saves them.',
})
export class ReportAnswer {
  @Field(() => CustomReportBreakdown)
  breakdown!: CustomReportBreakdown;

  @Field(() => [String])
  columns!: string[];

  @Field(() => CustomReportPeriod)
  period!: CustomReportPeriod;

  @Field(() => CustomReportResult)
  report!: CustomReportResult;
}

@ObjectType()
export class ReportQuestionPayload {
  @Field(() => ReportAnswer, { nullable: true })
  answer!: ReportAnswer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Questions of the shop's numbers (ANL-08, ADR-844), in English, Urdu or Roman Urdu: the AI reads
 * the question alone into one of Hatti's reports, which Hatti runs, with the reader's access.
 */
@Resolver()
export class ReportQuestionResolver {
  constructor(
    private readonly questions: ReportQuestionService,
    @Optional() @Inject(PlanAllowance) private readonly allowance?: PlanAllowance,
  ) {}

  @Query(() => ReportQuestions, { description: 'Whether the shop may ask, and how many it has.' })
  @RequireScopes('read_orders')
  async reportQuestions(@CurrentTenant() tenant: TenantContext): Promise<ReportQuestions> {
    return Object.assign(new ReportQuestions(), await this.questions.asking(tenant));
  }

  @Mutation(() => ReportQuestionPayload, {
    description:
      'Answers a question of the shop\'s numbers, such as "How much did I sell last week?" or ' +
      '"Is mahine sab se zyada kya bika?", with the report that answers it. The AI sees the ' +
      `question alone, never the numbers. ${REPORT_QUESTION_DAILY} a day; each answer spends an ` +
      'AI credit.',
  })
  @RequireScopes('read_orders')
  async reportQuestionAsk(
    @CurrentTenant() tenant: TenantContext,
    @Args('question') question: string,
  ): Promise<ReportQuestionPayload> {
    const trueProfit = !(await this.allowance?.excludes(tenant.shopId, 'trueProfit'));
    const result = await this.questions.ask(tenant, question, trueProfit);
    return Object.assign(new ReportQuestionPayload(), {
      answer: result.ok
        ? Object.assign(new ReportAnswer(), {
            breakdown: result.value.breakdown.toUpperCase() as CustomReportBreakdown,
            columns: result.value.columns,
            period: result.value.period.toUpperCase() as CustomReportPeriod,
            report: toReportResult(result.value.report, result.value.breakdown, tenant.currency),
          })
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
