import { PageInfo, UserError } from '@hatti/api';
import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import type { LowStockRecord } from '../low-stock.service.js';

@ObjectType({ description: "The shop's inventory settings." })
export class InventorySettings {
  @Field(() => Int, {
    description:
      'A variant is low on stock with this many units for sale online, or fewer: 5 until the ' +
      'shop says otherwise (INV-01).',
  })
  lowStockThreshold!: number;
}

@InputType({ description: 'Fields left out stay as they are.' })
export class InventorySettingsInput {
  @Field(() => Int, { nullable: true, description: '0 to 10,000 units.' })
  lowStockThreshold?: number | null;
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
      'out of stock.',
  })
  available!: number;

  /** For its inventoryItem's loader. */
  record!: LowStockRecord;
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
