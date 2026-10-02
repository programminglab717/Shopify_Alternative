import { Money } from '@hatti/api';
import {
  ArgsType,
  Field,
  Float,
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

export enum SalesDimension {
  SOURCE = 'SOURCE',
  VISIT_SOURCE = 'VISIT_SOURCE',
  CAMPAIGN = 'CAMPAIGN',
}

registerEnumType(SalesDimension, {
  name: 'SalesDimension',
  description: "What a sales report's rows break its sales down by (ADR-140).",
  valuesMap: {
    SOURCE: { description: 'The channel each order came through, as OrderSource says.' },
    VISIT_SOURCE: {
      description:
        "Where each order's last visit from elsewhere came from, as CustomerVisit.source says; " +
        'orders without a visit, such as those staff placed, together.',
    },
    CAMPAIGN: {
      description:
        "The campaign of each order's last visit from elsewhere, its utm_campaign, in any " +
        'letter case; orders without one together.',
    },
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

  @Field(() => SalesDimension, {
    nullable: true,
    description: 'What to break the sales down by. Without it, `rows` is empty.',
  })
  by?: SalesDimension | null;

  @Field(() => Int, { nullable: true, description: 'Rows at most, 1 to 250; default 50.' })
  first?: number | null;
}

@ObjectType({
  description:
    'What orders came to, as Shopify reports sales: an order counts when it was placed, ' +
    'cancelled ones aside, and so do the items of it that came back.',
})
export class Sales {
  @Field(() => Int, { description: 'Orders placed, cancelled ones aside.' })
  orders!: number;

  @Field(() => Money, {
    description:
      "Their items at the prices sold, without the sales tax those prices include, as Shopify's " +
      'reports give gross sales.',
  })
  grossSales!: Money;

  @Field(() => Money, {
    description: 'What was taken off the items, without its share of their tax.',
  })
  discounts!: Money;

  @Field(() => Money, {
    description:
      'Items in parcels that came back, refused or undeliverable, at the prices sold, less the ' +
      'tax that came back with them. Refunds are the money side, and are not taken off.',
  })
  returns!: Money;

  @Field(() => Money, { description: 'Gross sales less discounts and returns.' })
  netSales!: Money;

  @Field(() => Money, { description: 'Delivery charges, without their tax.' })
  shipping!: Money;

  @Field(() => Money, {
    description:
      "Fees charged for paying on delivery, as Shopify's reports count additional fees, without " +
      'their tax.',
  })
  additionalFees!: Money;

  @Field(() => Money, {
    description:
      'Net sales, shipping, additional fees and taxes: what the orders came to, less what came ' +
      'back.',
  })
  totalSales!: Money;

  @Field(() => Money, {
    description:
      "The sales tax the orders include, less that of the items that came back: the orders' " +
      "prices include it, and the other amounts leave it out, as Shopify's reports do.",
  })
  taxes!: Money;

  @Field(() => Money, {
    nullable: true,
    description: 'Gross sales less discounts, over the orders; null without orders.',
  })
  averageOrderValue!: Money | null;

  @Field(() => Money, {
    description:
      'What the items kept cost the shop (ADR-141): each unit at what its variant cost when it ' +
      'was sold, those that came back aside. Units sold without a cost count nothing.',
  })
  costOfGoods!: Money;

  @Field(() => Int, {
    description:
      'Units sold whose variant had no cost when they were sold, which costOfGoods leaves out.',
  })
  unitsWithoutCost!: number;

  @Field(() => Money, {
    description: "Net sales less the cost of goods, as Shopify's reports give gross profit.",
  })
  grossProfit!: Money;

  @Field(() => Float, {
    nullable: true,
    description: 'Gross profit as a share of net sales, 0 to 1; null without net sales.',
  })
  grossMargin!: number | null;

  @Field(() => Money, {
    description:
      "What couriers' statements charged for the orders' parcels, out and back, so far as " +
      'statements have come.',
  })
  shippingCosts!: Money;

  @Field(() => Money, {
    description:
      'What the items written off cost when sold: those of parcels that came back and were not ' +
      "restocked, of parcels lost, and of customers' returns checked in and not restocked.",
  })
  writeOffs!: Money;

  @Field(() => Money, {
    description: 'What couriers paid of claims for parcels lost or damaged.',
  })
  claimsRecovered!: Money;

  @Field(() => Money, {
    description:
      "What the orders made (ANL-03): total sales less taxes, the cost of goods, couriers' " +
      'charges and write-offs, plus claims recovered. Payment fees and ad spend are not in it ' +
      'yet.',
  })
  profit!: Money;
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

  @Field(() => Money, { description: 'Its items at the prices sold, without their tax.' })
  grossSales!: Money;

  @Field(() => Money, {
    description: 'What its units sold cost when sold; those without a cost count nothing.',
  })
  costOfGoods!: Money;
}

@ObjectType({ description: 'What the orders of one channel, source or campaign came to.' })
export class SalesRow {
  @Field(() => String, {
    nullable: true,
    description:
      'The OrderSource value, where the visits came from as CustomerVisit.source has it, or the ' +
      'campaign in the spelling most used; null for orders without a visit, or a campaign.',
  })
  key!: string | null;

  @Field({ description: 'What to call it: "Instagram" for instagram, say.' })
  title!: string;

  @Field(() => Sales)
  sales!: Sales;
}

@ObjectType({
  description:
    "Sales analytics (ANL-02): what a period's orders came to, the products that sold most, and " +
    'where the orders came from.',
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

  @Field(() => [SalesRow], {
    description: 'By what `by` names, most total sales first; none without it.',
  })
  rows!: SalesRow[];
}
