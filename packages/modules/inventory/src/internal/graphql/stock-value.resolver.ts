import { CurrentTenant, Money, RequireScopes, type TenantContext } from '@hatti/api';
import { money } from '@hatti/money';
import { Field, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { StockValueService } from '../stock-value.service.js';
import { Location } from './location.types.js';
import { toLocation } from './mappers.js';

@ObjectType({ description: 'What the stock at one location is worth at cost.' })
export class InventoryLocationValue {
  @Field(() => Location)
  location!: Location;

  @Field(() => Int, { description: 'Units on hand of tracked variants.' })
  units!: number;

  @Field(() => Int, { description: 'Of them, units of variants with no cost: not valued.' })
  unitsWithoutCost!: number;

  @Field(() => Money, { description: 'Units on hand times what one costs the shop now.' })
  value!: Money;
}

@ObjectType({
  description:
    "What the shop's stock is worth at cost (INV-03, ANL-03): each tracked variant's units on " +
    'hand times its cost, in all and by location, the most first.',
})
export class InventoryValue {
  @Field(() => Int)
  units!: number;

  @Field(() => Int, { description: 'Units of variants with no cost: not valued.' })
  unitsWithoutCost!: number;

  @Field(() => Money)
  value!: Money;

  @Field(() => [InventoryLocationValue])
  locations!: InventoryLocationValue[];
}

/** What the stock is worth (ADR-369): its cost is the products', so both are read. */
@Resolver()
export class StockValueResolver {
  constructor(private readonly service: StockValueService) {}

  @Query(() => InventoryValue, {
    description: "What the shop's stock on hand is worth at what it costs the shop.",
  })
  @RequireScopes('read_inventory', 'read_products')
  async inventoryValue(@CurrentTenant() tenant: TenantContext): Promise<InventoryValue> {
    const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
    const record = await this.service.value(tenant);
    return {
      units: record.units,
      unitsWithoutCost: record.unitsWithoutCost,
      value: amount(record.value),
      locations: record.locations.map((each) => ({
        location: toLocation(each.location),
        units: each.units,
        unitsWithoutCost: each.unitsWithoutCost,
        value: amount(each.value),
      })),
    };
  }
}
