import { UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { CUSTOM_REPORT_LIMITS } from '../custom-reports.js';
import { OrderExportFile } from './export.types.js';

export enum CustomReportBreakdown {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
  PRODUCT = 'PRODUCT',
  SOURCE = 'SOURCE',
  VISIT_SOURCE = 'VISIT_SOURCE',
  CAMPAIGN = 'CAMPAIGN',
}

registerEnumType(CustomReportBreakdown, {
  name: 'CustomReportBreakdown',
  description: "What a custom report's rows are (ADR-817).",
  valuesMap: {
    DAY: { description: "Each day, in the shop's time zone." },
    WEEK: { description: 'Each week, from Monday.' },
    MONTH: { description: 'Each month.' },
    PRODUCT: { description: 'The 250 products that sold most, their sales first.' },
    SOURCE: { description: 'The channel each order came through.' },
    VISIT_SOURCE: { description: "Where each order's last visit from elsewhere came from." },
    CAMPAIGN: { description: "The campaign of each order's last visit from elsewhere." },
  },
});

export enum CustomReportPeriod {
  TODAY = 'TODAY',
  YESTERDAY = 'YESTERDAY',
  LAST_7_DAYS = 'LAST_7_DAYS',
  LAST_30_DAYS = 'LAST_30_DAYS',
  LAST_90_DAYS = 'LAST_90_DAYS',
  THIS_WEEK = 'THIS_WEEK',
  LAST_WEEK = 'LAST_WEEK',
  THIS_MONTH = 'THIS_MONTH',
  LAST_MONTH = 'LAST_MONTH',
  LAST_12_MONTHS = 'LAST_12_MONTHS',
  THIS_YEAR = 'THIS_YEAR',
}

registerEnumType(CustomReportPeriod, {
  name: 'CustomReportPeriod',
  description:
    "The period a custom report covers, as of the day it is run in the shop's time zone: the " +
    '"last" days, weeks and months are whole ones before today; "this" week, month or year runs ' +
    'to the end of today.',
});

export enum CustomReportColumnKind {
  NUMBER = 'NUMBER',
  AMOUNT = 'AMOUNT',
  RATIO = 'RATIO',
}

registerEnumType(CustomReportColumnKind, {
  name: 'CustomReportColumnKind',
  description: "What a custom report's column holds.",
  valuesMap: {
    NUMBER: { description: 'A count: "3".' },
    AMOUNT: { description: 'An amount in the shop\'s currency, in major units: "3500.00".' },
    RATIO: { description: 'A ratio to four places: "0.6571" is 65.71%.' },
  },
});

@ObjectType({ description: "A custom report's column." })
export class CustomReportColumn {
  @Field({ description: '"net_sales", as a report\'s columns name it.' })
  key!: string;

  @Field({ description: '"Net sales".' })
  title!: string;

  @Field(() => CustomReportColumnKind)
  kind!: CustomReportColumnKind;

  @Field({ description: 'A line of true profit: shown only on the plans that have it (ADR-529).' })
  trueProfit!: boolean;
}

@ObjectType({ description: 'A report the shop saved of its own (ANL-06, ADR-817).' })
export class CustomReport {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => CustomReportBreakdown)
  breakdown!: CustomReportBreakdown;

  @Field(() => [String], { description: 'Its columns, in order, by their keys.' })
  columns!: string[];

  @Field(() => CustomReportPeriod)
  period!: CustomReportPeriod;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({ description: "A row of a custom report's." })
export class CustomReportRow {
  @Field(() => String, {
    nullable: true,
    description:
      "The product's ID, the channel as OrderSource names it, or the visit source or campaign " +
      'as the sales report keys them; null by day, week or month.',
  })
  key!: string | null;

  @Field({
    description:
      '"2026-10-01" for a day or the week from it, "2026-10" for a month; else its name.',
  })
  label!: string;

  @Field(() => [String], {
    nullable: 'items',
    description: "Each column's value, as its kind says; null for none.",
  })
  values!: (string | null)[];
}

@ObjectType({ description: 'What a custom report shows when run.' })
export class CustomReportResult {
  @Field(() => GraphQLISODateTime)
  placedFrom!: Date;

  @Field(() => GraphQLISODateTime)
  placedBefore!: Date;

  @Field(() => [CustomReportColumn], {
    description: "Its columns shown: true profit's are left out on the plans without it.",
  })
  columns!: CustomReportColumn[];

  @Field(() => [CustomReportRow])
  rows!: CustomReportRow[];

  @Field(() => [String], {
    nullable: 'itemsAndList',
    description: "The period's total of each column, for a report of sales; null by product.",
  })
  totals!: (string | null)[] | null;
}

@InputType()
export class CustomReportInput {
  @Field({ description: `1 to ${CUSTOM_REPORT_LIMITS.name} characters.` })
  name!: string;

  @Field(() => CustomReportBreakdown)
  breakdown!: CustomReportBreakdown;

  @Field(() => [String], {
    description:
      `1 to ${CUSTOM_REPORT_LIMITS.columns} of the columns customReportColumns gives the ` +
      'breakdown, in the order shown.',
  })
  columns!: string[];

  @Field(() => CustomReportPeriod)
  period!: CustomReportPeriod;
}

@ArgsType()
export class CustomReportRunArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: "With placedBefore, a period of the caller's in place of the report's own.",
  })
  placedFrom?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  placedBefore?: Date | null;
}

@ObjectType()
export class CustomReportPayload {
  @Field(() => CustomReport, { nullable: true })
  customReport!: CustomReport | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomReportDeletePayload {
  @Field(() => ID, { nullable: true, description: 'Null where there was nothing to delete.' })
  deletedId!: string | null;
}

@ObjectType()
export class CustomReportExportPayload {
  @Field(() => OrderExportFile, {
    nullable: true,
    description:
      '"monthly-sales.xlsx", an Excel workbook of one sheet: its rows, and their total last ' +
      'for a report of sales. Null where refused.',
  })
  file!: OrderExportFile | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
