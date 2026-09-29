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

  @Field(() => OrderExportLayout, { defaultValue: OrderExportLayout.ORDERS })
  layout!: OrderExportLayout;
}

@ObjectType()
export class OrdersExportPayload {
  @Field(() => String, {
    nullable: true,
    description:
      'The CSV, UTF-8 with a byte-order mark so that Excel shows Urdu correctly. Amounts are in ' +
      'major units, such as 3499.00; times are in the shop time zone. A last column says who ' +
      'exported it and when.',
  })
  csv!: string | null;

  @Field(() => Int, { description: 'Rows, not counting the header.' })
  rowCount!: number;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
