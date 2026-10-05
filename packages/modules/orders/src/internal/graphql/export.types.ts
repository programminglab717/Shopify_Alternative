import { UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { OrderRiskLevel, OrderStage } from './order.types.js';

export enum OrderExportLayout {
  ORDERS = 'ORDERS',
  LINE_ITEMS = 'LINE_ITEMS',
}

registerEnumType(OrderExportLayout, {
  name: 'OrderExportLayout',
  description: 'How an order export lays out its rows.',
  valuesMap: {
    ORDERS: { description: 'A row per order, with its items in one cell and its totals.' },
    LINE_ITEMS: {
      description: "A row per line item, with its order's number, date, stage and customer.",
    },
  },
});

export enum OrderExportFormat {
  CSV = 'CSV',
  XLSX = 'XLSX',
}

registerEnumType(OrderExportFormat, {
  name: 'OrderExportFormat',
  description: 'The file an order export comes as (ADR-182).',
  valuesMap: {
    CSV: { description: 'Comma-separated text, as the export has always come.' },
    XLSX: {
      description:
        'An Excel workbook: amounts and counts as numbers, times as dates, the header in view ' +
        'with a filter on it.',
    },
  },
});

@ObjectType({ description: 'An export as a file to save.' })
export class OrderExportFile {
  @Field({
    description: '"orders-2026-10-05.xlsx": the day it was exported, in the shop time zone.',
  })
  filename!: string;

  @Field({ description: '"text/csv; charset=utf-8", or an Excel workbook\'s.' })
  contentType!: string;

  @Field({ description: "The file's bytes, in base64." })
  content!: string;
}

@ArgsType()
export class OrdersExportArgs {
  @Field(() => String, {
    nullable: true,
    description: 'Searches as `orders(query:)` does.',
  })
  query?: string | null;

  @Field(() => OrderStage, { nullable: true })
  stage?: OrderStage | null;

  @Field(() => OrderRiskLevel, { nullable: true })
  riskLevel?: OrderRiskLevel | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Placed at or after this.' })
  placedFrom?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Placed before this.' })
  placedBefore?: Date | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'As `orders(hasTransferReceipt:)` takes it.',
  })
  hasTransferReceipt?: boolean | null;

  @Field(() => OrderExportLayout, { defaultValue: OrderExportLayout.ORDERS })
  layout!: OrderExportLayout;

  @Field(() => OrderExportFormat, { defaultValue: OrderExportFormat.CSV })
  format!: OrderExportFormat;
}

@ObjectType()
export class OrdersExportPayload {
  @Field(() => String, {
    nullable: true,
    description:
      'The CSV, UTF-8 with a byte-order mark so that Excel shows Urdu correctly. Amounts are in ' +
      'major units, such as 3499.00; times are in the shop time zone. A last column says who ' +
      'exported it and when. Null for a workbook.',
  })
  csv!: string | null;

  @Field(() => OrderExportFile, {
    nullable: true,
    description: 'The export as a file to save, in the format asked for.',
  })
  file!: OrderExportFile | null;

  @Field(() => Int, { description: 'Rows, not counting the header.' })
  rowCount!: number;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
