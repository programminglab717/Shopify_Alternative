import { PageInfo, UserError } from '@hatti/api';
import { Field, Float, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { LowStockRecord } from '../low-stock.service.js';

@ObjectType({ description: "The shop's inventory settings." })
export class InventorySettings {
  @Field(() => Int, {
    description:
      'A variant is low on stock with this many units for sale online, or fewer: 5 until the ' +
      'shop says otherwise (INV-01).',
  })
  lowStockThreshold!: number;

  @Field({
    description:
      'Whether an order paid on delivery, with nothing paid or asked in advance, that no one ' +
      'location has all of is split among those that do, each part an order of its own shipped ' +
      'from its location with no delivery charge (INV-10, ADR-898). Off until turned on.',
  })
  splitOrdersAcrossLocations!: boolean;
}

@InputType({ description: 'Fields left out stay as they are.' })
export class InventorySettingsInput {
  @Field(() => Int, { nullable: true, description: '0 to 10,000 units.' })
  lowStockThreshold?: number | null;

  @Field(() => Boolean, { nullable: true })
  splitOrdersAcrossLocations?: boolean | null;
}

@ObjectType()
export class InventorySettingsUpdatePayload {
  @Field(() => InventorySettings, { nullable: true })
  inventorySettings!: InventorySettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "A variant of an active product running low or out of stock, at the shop's threshold, with " +
    'what staff need to reorder it (INV-01).',
})
export class LowStockItem {
  @Field(() => ID, { description: 'The variant.' })
  variantId!: string;

  @Field(() => ID)
  productId!: string;

  @Field()
  productTitle!: string;

  @Field()
  variantTitle!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => Int, {
    description:
      "Units that can be sold online, as the variant's inventoryQuantity says: none or fewer is " +
      'out of stock. Listed for one location, the units available there.',
  })
  available!: number;

  /** For its inventoryItem's loader. */
  record!: LowStockRecord;
}

export enum StockSeasonKey {
  RAMADAN = 'RAMADAN',
  EID_UL_ADHA = 'EID_UL_ADHA',
  SUMMER_LAWN = 'SUMMER_LAWN',
  INDEPENDENCE_DAY = 'INDEPENDENCE_DAY',
  WINTER_COLLECTION = 'WINTER_COLLECTION',
  WEDDING_SEASON = 'WEDDING_SEASON',
}

registerEnumType(StockSeasonKey, {
  name: 'StockSeasonKey',
  description:
    'A shopping season of Pakistan (INV-08, ADR-863, ADR-891). Those that follow the moon: ' +
    "RAMADAN, from its first day through Eid ul Fitr's third; EID_UL_ADHA, from Dhu al-Qadah's " +
    "25th through Eid's third. Those on the same days each year: SUMMER_LAWN, 15 February to " +
    '30 April; INDEPENDENCE_DAY, 1 to 14 August; WINTER_COLLECTION, October; WEDDING_SEASON, ' +
    "1 November to 14 February. Where the moon's meets another, the moon's is the one given.",
});

@ObjectType({
  description:
    'A season on or ahead (ADR-863), and how much faster than usual stock sold in it last year: ' +
    "its units a day then over its units a day in the 30 days before, as Pakistan's days fall.",
})
export class StockSeason {
  @Field(() => StockSeasonKey)
  key!: StockSeasonKey;

  @Field({ description: 'Its first day this time, YYYY-MM-DD.' })
  startsOn!: string;

  @Field({ description: 'Its last day, YYYY-MM-DD.' })
  endsOn!: string;

  @Field(() => Float, {
    nullable: true,
    description: '0.25 to 8; null where nothing sold in it, or the month before it, last year.',
  })
  lift!: number | null;

  @Field({
    description: "The lift is the shop's, all its stock together, as this has no such history.",
  })
  fromShop!: boolean;
}

@ObjectType({ description: "A week of a variant's forecast (INV-08, ADR-893)." })
export class StockWeek {
  @Field({ description: 'Its first day, YYYY-MM-DD: today, then every seventh day after.' })
  startsOn!: string;

  @Field(() => Int, {
    description:
      "Units expected to sell in it, at the pace of the last 30 days and a season's lift.",
  })
  units!: number;

  @Field(() => Int, {
    description: 'What is left of what is available at its end, never below none.',
  })
  left!: number;
}

@ObjectType()
export class LowStockItemEdge {
  @Field()
  cursor!: string;

  @Field(() => LowStockItem)
  node!: LowStockItem;
}

@ObjectType()
export class LowStockItemConnection {
  @Field(() => [LowStockItemEdge])
  edges!: LowStockItemEdge[];

  @Field(() => [LowStockItem])
  nodes!: LowStockItem[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}
