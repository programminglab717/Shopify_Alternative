import type { TenantContext } from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { locationFromJson, type LocationJson } from './location-store.js';
import type { LocationRecord } from './records.js';

/** What the stock at one location is worth at cost. */
export interface LocationStockValue {
  location: LocationRecord;
  /** Units on hand of tracked variants. */
  units: number;
  /** Of them, units of variants the shop gave no cost: not in `value`. */
  unitsWithoutCost: number;
  /** Units on hand times what one costs, in minor units. */
  value: bigint;
}

/** What the shop's stock is worth at cost, in all and by location, the most first. */
export interface StockValueRecord {
  units: number;
  unitsWithoutCost: number;
  value: bigint;
  locations: LocationStockValue[];
}

/**
 * What the shop's stock is worth (INV-03, ANL-03, ADR-369): each tracked variant's units on hand
 * times what one costs the shop, as its cost is now, worked out when asked. Committed units are
 * on hand still, so they count until shipped; none or fewer on hand counts nothing.
 */
@Injectable()
export class StockValueService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
  ) {}

  async value(tenant: TenantContext): Promise<StockValueRecord> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        variant_id: string;
        on_hand: number;
        location: LocationJson;
      }>(sql`
        SELECT l.variant_id, l.on_hand, to_jsonb(loc) AS location
          FROM inventory.levels l
          JOIN inventory.items i ON i.shop_id = l.shop_id AND i.variant_id = l.variant_id
          JOIN inventory.locations loc ON loc.shop_id = l.shop_id AND loc.id = l.location_id
         WHERE l.shop_id = ${tenant.shopId} AND i.tracked AND l.on_hand > 0`);
      const costs = await this.variants.snapshotsOf(tx, tenant.shopId, [
        ...new Set(rows.map((row) => row.variant_id)),
      ]);
      const byLocation = new Map<string, LocationStockValue>();
      for (const row of rows) {
        const at = byLocation.get(row.location.id) ?? {
          location: locationFromJson(row.location),
          units: 0,
          unitsWithoutCost: 0,
          value: 0n,
        };
        const cost = costs.get(row.variant_id)?.cost ?? null;
        at.units += row.on_hand;
        if (cost === null) at.unitsWithoutCost += row.on_hand;
        else at.value += cost * BigInt(row.on_hand);
        byLocation.set(row.location.id, at);
      }
      const locations = [...byLocation.values()].sort((a, b) =>
        a.value === b.value
          ? a.location.name.localeCompare(b.location.name)
          : a.value > b.value
            ? -1
            : 1,
      );
      return {
        units: locations.reduce((sum, each) => sum + each.units, 0),
        unitsWithoutCost: locations.reduce((sum, each) => sum + each.unitsWithoutCost, 0),
        value: locations.reduce((sum, each) => sum + each.value, 0n),
        locations,
      };
    });
  }
}
