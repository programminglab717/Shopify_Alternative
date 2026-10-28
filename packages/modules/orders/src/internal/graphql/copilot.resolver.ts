import {
  CurrentTenant,
  PlanAllowance,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { Inject, Optional } from '@nestjs/common';
import {
  Args,
  Field,
  Float,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { COPILOT_DAILY, CopilotService, type CopilotDraft as Draft } from '../copilot.service.js';
import { toReportResult } from './custom-report.resolver.js';
import type { CustomReportBreakdown, CustomReportPeriod } from './custom-report.types.js';
import { ReportAnswer } from './report-question.resolver.js';

export enum CopilotDraftKind {
  DISCOUNT = 'DISCOUNT',
  SEGMENT = 'SEGMENT',
  REPORT = 'REPORT',
}

registerEnumType(CopilotDraftKind, {
  name: 'CopilotDraftKind',
  description: 'What the copilot drafted (AI-01, ADR-894).',
});

@ObjectType({ description: 'Asking the merchant copilot (AI-01, ADR-894).' })
export class Copilot {
  @Field({ description: 'Whether the copilot drafts: false until its AI is set up.' })
  available!: boolean;

  @Field(() => Int)
  usedToday!: number;

  @Field(() => Int)
  limitPerDay!: number;
}

@ObjectType({
  description:
    'A discount code as the copilot drafted it, for staff to make with discountCodeCreate: ' +
    'exactly one of percentage, amount or freeShipping.',
})
export class CopilotDiscountDraft {
  @Field()
  code!: string;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => Float, { nullable: true })
  percentage!: number | null;

  @Field(() => String, { nullable: true, description: 'Whole rupees off, as digits.' })
  amount!: string | null;

  @Field()
  freeShipping!: boolean;

  @Field(() => String, { nullable: true, description: 'Whole rupees, as digits.' })
  minimumSubtotal!: string | null;

  @Field(() => String, { nullable: true, description: 'Its first day, YYYY-MM-DD; null for now.' })
  startsOn!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Its last day, YYYY-MM-DD; null for no end.',
  })
  endsOn!: string | null;

  @Field()
  oncePerCustomer!: boolean;

  @Field(() => Int, { nullable: true })
  usageLimit!: number | null;
}

@ObjectType({
  description: 'A segment as the copilot drafted it, for staff to save with segmentCreate.',
})
export class CopilotSegmentDraft {
  @Field()
  name!: string;

  @Field({ description: 'In the segment query language, checked against the shop.' })
  query!: string;

  @Field(() => Int, { description: 'Customers it matches now.' })
  customers!: number;
}

@ObjectType({ description: 'A draft for staff to confirm, or a report already run.' })
export class CopilotDraft {
  @Field(() => CopilotDraftKind)
  kind!: CopilotDraftKind;

  @Field(() => CopilotDiscountDraft, { nullable: true })
  discount!: CopilotDiscountDraft | null;

  @Field(() => CopilotSegmentDraft, { nullable: true })
  segment!: CopilotSegmentDraft | null;

  @Field(() => ReportAnswer, { nullable: true })
  report!: ReportAnswer | null;
}

@ObjectType()
export class CopilotDraftPayload {
  @Field(() => CopilotDraft, { nullable: true })
  draft!: CopilotDraft | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

function toDraft(draft: Draft, currency: TenantContext['currency']): CopilotDraft {
  return Object.assign(new CopilotDraft(), {
    kind: draft.kind.toUpperCase() as CopilotDraftKind,
    discount:
      draft.kind === 'discount' ? Object.assign(new CopilotDiscountDraft(), draft.discount) : null,
    segment:
      draft.kind === 'segment'
        ? Object.assign(new CopilotSegmentDraft(), {
            name: draft.name,
            query: draft.query,
            customers: draft.customers,
          })
        : null,
    report:
      draft.kind === 'report'
        ? Object.assign(new ReportAnswer(), {
            breakdown: draft.breakdown.toUpperCase() as CustomReportBreakdown,
            columns: draft.columns,
            period: draft.period.toUpperCase() as CustomReportPeriod,
            report: toReportResult(draft.report, draft.breakdown, currency),
          })
        : null,
  });
}

/**
 * The merchant copilot (AI-01, ADR-894): a request in English, Urdu or Roman Urdu drafted into a
 * discount code, a segment or a report. Nothing is made: staff confirm a draft through the
 * mutations that make it, with their own access.
 */
@Resolver()
export class CopilotResolver {
  constructor(
    private readonly service: CopilotService,
    @Optional() @Inject(PlanAllowance) private readonly allowance?: PlanAllowance,
  ) {}

  @Query(() => Copilot, {
    description: 'Whether the shop may ask the copilot, and how often it has.',
  })
  @RequireScopes('read_orders')
  async copilot(@CurrentTenant() tenant: TenantContext): Promise<Copilot> {
    return Object.assign(new Copilot(), await this.service.asking(tenant));
  }

  @Mutation(() => CopilotDraftPayload, {
    description:
      'Drafts what a request asks for, such as "Eid ke liye 15% off code bana do" or "customers ' +
      'in Lahore who ordered twice": a discount code or a segment for staff to confirm, or a ' +
      'report, run. The AI sees the request, the segment fields and the report choices, never ' +
      `the shop's data. ${COPILOT_DAILY} a day; each draft spends an AI credit.`,
  })
  @RequireScopes('read_orders')
  async copilotDraft(
    @CurrentTenant() tenant: TenantContext,
    @Args('request') request: string,
  ): Promise<CopilotDraftPayload> {
    const trueProfit = !(await this.allowance?.excludes(tenant.shopId, 'trueProfit'));
    const result = await this.service.draft(tenant, request, trueProfit);
    return Object.assign(new CopilotDraftPayload(), {
      draft: result.ok ? toDraft(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
