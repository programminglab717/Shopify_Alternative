import { CurrentTenant, Money, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import {
  Args,
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  INVENTORY_REPORT_DAYS,
  INVENTORY_REPORT_LIMIT,
  InventoryReportService,
  type InventoryReportSort,
} from '../inventory-report.service.js';

export enum InventoryReportSortKey {
  SELL_THROUGH = 'SELL_THROUGH',
  SLOWEST = 'SLOWEST',
  STOCKOUTS = 'STOCKOUTS',
}

registerEnumType(InventoryReportSortKey, {
  name: 'InventoryReportSortKey',
  description: "Which of an inventory report's variants it lists, and in what order (ANL-05).",
  valuesMap: {
    SELL_THROUGH: { description: 'Those that sold, the most sold of what they had first.' },
    SLOWEST: {
      description: 'Those with stock on hand, what never sold first, then what sold longest ago.',
    },
    STOCKOUTS: { description: 'Those that ran out or were out, the longest out first.' },
  },
});

export enum InventoryAgeingBucket {
  DAYS_0_30 = 'DAYS_0_30',
  DAYS_31_60 = 'DAYS_31_60',
  DAYS_61_90 = 'DAYS_61_90',
  OVER_90 = 'OVER_90',
  NEVER = 'NEVER',
}

registerEnumType(InventoryAgeingBucket, {
  name: 'InventoryAgeingBucket',
  description: 'How long ago stock on hand last sold: in days, or never.',
});

@ObjectType({ description: 'Stock on hand last sold within some days, or never sold.' })
export class InventoryAgeing {
  @Field(() => InventoryAgeingBucket)
  bucket!: InventoryAgeingBucket;

  @Field(() => Int)
  variants!: number;

  @Field(() => Int)
  units!: number;

  @Field(() => Money, { description: 'Units times what one costs the shop, of those with a cost.' })
  value!: Money;

  @Field(() => Int, { description: 'Units of variants with no cost: not valued.' })
  unitsWithoutCost!: number;
}

@ObjectType({ description: 'One variant in an inventory report.' })
export class InventoryReportRow {
  @Field(() => ID)
  variantId!: string;

  @Field(() => ID)
  productId!: string;

  @Field()
  productTitle!: string;

  @Field()
  variantTitle!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => Int, { description: 'At all the shop’s locations, now.' })
  onHand!: number;

  @Field(() => Int)
  available!: number;

  @Field(() => Int, { description: 'Units sold in the period, less those released.' })
  sold!: number;

  @Field(() => Float, {
    nullable: true,
    description: 'Of sold and available now, the share sold, in percent; null with neither.',
  })
  sellThrough!: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null when it never sold.' })
  lastSoldAt!: Date | null;

  @Field(() => Int, { nullable: true })
  daysSinceSale!: number | null;

  @Field(() => Float, {
    description:
      'Days it had none for sale in the period, to one decimal, at the location it was out ' +
      'longest.',
  })
  daysOut!: number;

  @Field(() => Int, { description: 'How many times it ran out there in the period.' })
  stockouts!: number;

  @Field(() => Money, { nullable: true, description: 'What one costs the shop; null for none.' })
  cost!: Money | null;
}

@ObjectType({
  description:
    "Inventory reports (ANL-05): of the shop's tracked variants, what sold of what there was to " +
    'sell over a period, how long ago the stock on hand last sold, and what ran out.',
})
export class InventoryReport {
  @Field(() => Int)
  days!: number;

  @Field(() => GraphQLISODateTime)
  since!: Date;

  @Field(() => Int)
  sold!: number;

  @Field(() => Int)
  onHand!: number;

  @Field(() => Float, { nullable: true })
  sellThrough!: number | null;

  @Field(() => Int, { description: 'Variants with none available now.' })
  outNow!: number;

  @Field(() => Int, { description: 'Variants that ran out, or were out, in the period.' })
  ranOut!: number;

  @Field(() => [InventoryAgeing])
  ageing!: InventoryAgeing[];

  @Field(() => [InventoryReportRow])
  rows!: InventoryReportRow[];
}

/** Inventory reports (ANL-05, ADR-455): from the stock ledger, with the products' titles and costs. */
@Resolver()
export class InventoryReportResolver {
  constructor(private readonly service: InventoryReportService) {}

  @Query(() => InventoryReport, {
    description:
      'Sell-through, how long ago stock last sold, and stock-outs, over the last 7, 30 or 90 days.',
  })
  @RequireScopes('read_inventory', 'read_products')
  async inventoryReport(
    @CurrentTenant() tenant: TenantContext,
    @Args('days', { type: () => Int, defaultValue: 30, description: '7, 30 or 90.' })
    days: number,
    @Args('sortKey', {
      type: () => InventoryReportSortKey,
      defaultValue: InventoryReportSortKey.SELL_THROUGH,
    })
    sortKey: InventoryReportSortKey,
    @Args('first', { type: () => Int, defaultValue: 50, description: '1 to 250.' })
    first: number,
  ): Promise<InventoryReport> {
    if (!(INVENTORY_REPORT_DAYS as readonly number[]).includes(days)) {
      throw badUserInput('days must be 7, 30 or 90');
    }
    if (!Number.isInteger(first) || first < 1 || first > INVENTORY_REPORT_LIMIT) {
      throw badUserInput(`first must be 1 to ${INVENTORY_REPORT_LIMIT}`);
    }
    const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
    const record = await this.service.report(tenant, {
      days,
      sort: sortKey.toLowerCase() as InventoryReportSort,
      first,
    });
    return {
      ...record,
      ageing: record.ageing.map((each) => ({
        ...each,
        bucket: each.bucket.toUpperCase() as InventoryAgeingBucket,
        value: amount(each.value),
      })),
      rows: record.rows.map((row) => ({
        ...row,
        variantId: toPublicId('variant', row.variantId),
        productId: toPublicId('product', row.productId),
        cost: row.cost === null ? null : amount(row.cost),
      })),
    };
  }
}
