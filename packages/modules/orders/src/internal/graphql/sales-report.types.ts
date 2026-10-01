import { Money } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { SALES_REPORT_LIMITS } from '../sales-report.service.js';

export enum SalesInterval {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

registerEnumType(SalesInterval, {
  name: 'SalesInterval',
  description: "How a sales report divides its period, in the shop's time zone.",
  valuesMap: {
    DAY: { description: 'Day by day.' },
    WEEK: { description: 'Week by week, from Monday.' },
    MONTH: { description: 'Month by month.' },
  },
});

@ArgsType()
export class SalesReportArgs {
  @Field(() => GraphQLISODateTime, { description: 'Orders placed at or after this.' })
  placedFrom!: Date;

  @Field(() => GraphQLISODateTime, {
    description: `Orders placed before this; at most ${SALES_REPORT_LIMITS.days} days after placedFrom.`,
  })
  placedBefore!: Date;

  @Field(() => SalesInterval, { defaultValue: SalesInterval.DAY })
  interval!: SalesInterval;

  @Field(() => Int, {
    nullable: true,
    description: 'How many of the products that sold most, 1 to 250; default 10.',
  })
  topProducts?: number | null;
}

@ObjectType({
  description:
    'What orders came to, as Shopify reports sales: an order counts when it was placed, ' +
    'cancelled ones aside, and so do the items of it that came back.',
})
export class Sales {
  @Field(() => Int, { description: 'Orders placed, cancelled ones aside.' })
  orders!: number;

  @Field(() => Money, { description: 'Their items at the prices sold.' })
  grossSales!: Money;

  @Field(() => Money)
  discounts!: Money;

  @Field(() => Money, {
    description:
      'Items in parcels that came back, refused or undeliverable, at the prices sold. Refunds ' +
      'are the money side, and are not taken off.',
  })
  returns!: Money;

  @Field(() => Money, { description: 'Gross sales less discounts and returns.' })
  netSales!: Money;

  @Field(() => Money, { description: 'Delivery charges.' })
  shipping!: Money;

  @Field(() => Money, { description: 'Net sales and shipping.' })
  totalSales!: Money;

  @Field(() => Money, {
    nullable: true,
    description: 'Gross sales less discounts, over the orders; null without orders.',
  })
  averageOrderValue!: Money | null;
}

@ObjectType({ description: 'A day, week or month of a sales report.' })
export class SalesPeriod {
  @Field(() => GraphQLISODateTime, { description: "When it starts, in the shop's time zone." })
  start!: Date;

  @Field(() => Sales)
  sales!: Sales;
}

@ObjectType({ description: 'What a product sold in a sales report.' })
export class ProductSales {
  @Field(() => ID, { description: 'The product, which may have been deleted since.' })
  productId!: string;

  @Field({ description: 'Its title as it was last sold.' })
  title!: string;

  @Field(() => Int)
  unitsSold!: number;

  @Field(() => Int, { description: 'Orders with it in them.' })
  orders!: number;

  @Field(() => Money, { description: 'Its items at the prices sold.' })
  grossSales!: Money;
}

@ObjectType({
  description:
    "Sales analytics (ANL-02): what a period's orders came to, and the products that sold most.",
})
export class SalesReport {
  @Field(() => Sales)
  totals!: Sales;

  @Field(() => [SalesPeriod], {
    description: 'Every day, week or month of the period, those without orders included.',
  })
  periods!: SalesPeriod[];

  @Field(() => [ProductSales], { description: 'Most sales first.' })
  topProducts!: ProductSales[];
}
