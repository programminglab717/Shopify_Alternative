import {
  CurrentTenant,
  PlanAllowance,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  failOne,
  hasCapability,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import { Inject, Optional } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  CUSTOM_REPORT_LIMITS,
  CustomReportService,
  reportColumnsOf,
  type CustomReportInput as CustomReportValues,
  type CustomReportRecord,
  type ReportBreakdown,
  type ReportColumnKind,
  type ReportPeriod,
  type ReportValue,
} from '../custom-reports.js';
import { OrderExportFile } from './export.types.js';
import {
  CustomReport,
  CustomReportBreakdown,
  CustomReportColumn,
  CustomReportColumnKind,
  CustomReportDeletePayload,
  CustomReportExportPayload,
  CustomReportInput,
  CustomReportPayload,
  CustomReportPeriod,
  CustomReportResult,
  CustomReportRow,
  CustomReportRunArgs,
} from './custom-report.types.js';

const valuesOf = (input: CustomReportInput): CustomReportValues => ({
  name: input.name,
  breakdown: input.breakdown.toLowerCase() as ReportBreakdown,
  columns: input.columns,
  period: input.period.toLowerCase() as ReportPeriod,
});

/** A period given by the caller: both its ends, or neither. */
function overOf(args: CustomReportRunArgs): { placedFrom: Date; placedBefore: Date } | undefined {
  if (!args.placedFrom && !args.placedBefore) return undefined;
  if (!args.placedFrom || !args.placedBefore) {
    throw badUserInput('Give placedFrom and placedBefore together, or neither');
  }
  return { placedFrom: args.placedFrom, placedBefore: args.placedBefore };
}

/**
 * Reports the shop saves of its own (ANL-06, ADR-817): the sales report broken down one way, with
 * the columns chosen, over a period that moves with the day. Read and saved by those who read
 * orders; exported by those who export them.
 */
@Resolver()
export class CustomReportResolver {
  constructor(
    private readonly reports: CustomReportService,
    @Optional() @Inject(PlanAllowance) private readonly allowance?: PlanAllowance,
  ) {}

  async #trueProfit(shopId: string): Promise<boolean> {
    return !(await this.allowance?.excludes(shopId, 'trueProfit'));
  }

  @Query(() => [CustomReport], {
    description: "The shop's custom reports, by name (ANL-06).",
  })
  @RequireScopes('read_orders')
  async customReports(@CurrentTenant() tenant: TenantContext): Promise<CustomReport[]> {
    return (await this.reports.list(tenant)).map(toReport);
  }

  @Query(() => CustomReport, { nullable: true })
  @RequireScopes('read_orders')
  async customReport(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CustomReport | null> {
    const uuid = tryFromPublicId(id, 'customReport');
    const report = uuid ? await this.reports.get(tenant, uuid) : null;
    return report ? toReport(report) : null;
  }

  @Query(() => [CustomReportColumn], {
    description: 'The columns a custom report of `breakdown` may show, in the order offered.',
  })
  @RequireScopes('read_orders')
  customReportColumns(
    @Args('breakdown', { type: () => CustomReportBreakdown }) breakdown: CustomReportBreakdown,
  ): CustomReportColumn[] {
    return Object.entries(reportColumnsOf(breakdown.toLowerCase() as ReportBreakdown)).map(
      ([key, column]) =>
        Object.assign(new CustomReportColumn(), {
          key,
          title: column.title,
          kind: column.kind.toUpperCase() as CustomReportColumnKind,
          trueProfit: Boolean(column.trueProfit),
        }),
    );
  }

  @Query(() => CustomReportResult, {
    nullable: true,
    description:
      'What a custom report shows, worked out from the orders now: over its own period as of ' +
      'today, or over one given of a year at most. Null for no such report.',
  })
  @RequireScopes('read_orders')
  async customReportRun(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CustomReportRunArgs,
  ): Promise<CustomReportResult | null> {
    const over = overOf(args);
    const uuid = tryFromPublicId(args.id, 'customReport');
    const report = uuid ? await this.reports.get(tenant, uuid) : null;
    if (!report) return null;
    const result = await this.reports.run(
      tenant,
      report,
      await this.#trueProfit(tenant.shopId),
      new Date(),
      over,
    );
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    const { columns, rows, totals, placedFrom, placedBefore } = result.value;
    const text = (values: ReportValue[]) =>
      values.map((value, index) => valueText(value, columns[index]!.kind, tenant.currency));
    return Object.assign(new CustomReportResult(), {
      placedFrom,
      placedBefore,
      columns: columns.map((column) =>
        Object.assign(new CustomReportColumn(), {
          ...column,
          kind: column.kind.toUpperCase() as CustomReportColumnKind,
          trueProfit: Boolean(
            reportColumnsOf(report.breakdown)[column.key as keyof object]?.trueProfit,
          ),
        }),
      ),
      rows: rows.map((row) =>
        Object.assign(new CustomReportRow(), {
          key:
            report.breakdown === 'product' && row.key
              ? toPublicId('product', row.key)
              : report.breakdown === 'source' && row.key
                ? row.key.toUpperCase()
                : row.key,
          label: row.label,
          values: text(row.values),
        }),
      ),
      totals: totals && text(totals),
    });
  }

  @Mutation(() => CustomReportPayload, {
    description: `Saves a custom report (ANL-06, ADR-817). A shop keeps up to ${CUSTOM_REPORT_LIMITS.perShop}.`,
  })
  @RequireScopes('read_orders')
  async customReportCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CustomReportInput,
  ): Promise<CustomReportPayload> {
    return payload(await this.reports.create(tenant, valuesOf(input)));
  }

  @Mutation(() => CustomReportPayload, { description: 'Changes a custom report, all of it.' })
  @RequireScopes('read_orders')
  async customReportUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: CustomReportInput,
  ): Promise<CustomReportPayload> {
    const uuid = tryFromPublicId(id, 'customReport');
    return payload(
      uuid
        ? await this.reports.update(tenant, uuid, valuesOf(input))
        : failOne(['id'], 'NOT_FOUND', 'Report not found'),
    );
  }

  @Mutation(() => CustomReportDeletePayload, {
    description: 'Deletes a custom report, and the scheduled exports that send it (ADR-818).',
  })
  @RequireScopes('read_orders')
  async customReportDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CustomReportDeletePayload> {
    const uuid = tryFromPublicId(id, 'customReport');
    const deleted = uuid ? await this.reports.delete(tenant, uuid) : false;
    return Object.assign(new CustomReportDeletePayload(), { deletedId: deleted ? id : null });
  }

  @Mutation(() => CustomReportExportPayload, {
    description:
      'A custom report as an Excel workbook, over its own period or one given. Staff need to ' +
      'be an owner, a manager or an accountant. Every export is recorded in the audit log.',
  })
  @RequireScopes('read_orders')
  async customReportExport(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CustomReportRunArgs,
  ): Promise<CustomReportExportPayload> {
    if (tenant.actor.kind === 'staff' && !hasCapability(tenant.actor, 'export_orders')) {
      throw deniedToRole('Access denied. Only owners, managers and accountants export reports.');
    }
    const over = overOf(args);
    const uuid = tryFromPublicId(args.id, 'customReport');
    const result = uuid
      ? await this.reports.export(
          tenant,
          uuid,
          await this.#trueProfit(tenant.shopId),
          new Date(),
          over,
        )
      : failOne<never>(['id'], 'NOT_FOUND', 'Report not found');
    return Object.assign(new CustomReportExportPayload(), {
      file: result.ok
        ? Object.assign(new OrderExportFile(), {
            filename: result.value.filename,
            contentType: result.value.contentType,
            content: result.value.content.toString('base64'),
          })
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** A value as the API gives it: an amount in major units, a count, or a ratio to four places. */
function valueText(value: ReportValue, kind: ReportColumnKind, currency: string): string | null {
  if (value === null) return null;
  if (kind === 'amount') return toMajorString(money(BigInt(value), currency as CurrencyCode));
  return String(value);
}

function toReport(record: CustomReportRecord): CustomReport {
  return Object.assign(new CustomReport(), {
    id: toPublicId('customReport', record.id),
    name: record.name,
    breakdown: record.breakdown.toUpperCase() as CustomReportBreakdown,
    columns: [...record.columns],
    period: record.period.toUpperCase() as CustomReportPeriod,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function payload(result: MutationResult<CustomReportRecord>): CustomReportPayload {
  return Object.assign(new CustomReportPayload(), {
    customReport: result.ok ? toReport(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}
