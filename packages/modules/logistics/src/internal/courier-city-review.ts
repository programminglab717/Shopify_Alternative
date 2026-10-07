import { Database } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { cityKey } from './city-names.js';
import { COURIER_CITY_LIMITS } from './courier-cities.service.js';

/**
 * How many shops must give a city the same name with a courier, none giving another, for it to be
 * every shop's (ADR-260): `logistics.shared_courier_cities` holds to it.
 */
export const SHARED_CITY_SHOPS = 3;

/** Shops' names for a city with a courier, as Hatti's people review them (ADR-260). */
export interface ShopsCityNames {
  /** The city by its letters and digits in lower case, as names are kept for it. */
  cityKey: string;
  /** The city as one shop's staff gave it. */
  city: string;
  /** Each name shops gave it, with how many gave it, the most first. */
  names: { courierCity: string; shops: number }[];
  /** The name every shop's parcels to it go as, where shops agree; null where they don't yet. */
  shared: string | null;
}

/** Hatti's own name for a city with a courier, which comes before any shops agree on. */
export interface HattiCityName {
  city: string;
  courierCity: string;
}

const COURIER = /^[a-z][a-z_]{1,29}$/;

/**
 * Couriers' names for cities across shops, for Hatti's people (ADR-260), through the system
 * login, by a command whoever runs Hatti runs, never through the Admin API: the names shops gave,
 * which they agree on, and Hatti's own names, kept and forgotten.
 */
export class CourierCityReview {
  constructor(private readonly db: Database) {}

  /**
   * Shops' names for cities with `courier`, by city, those most shops named first, without saying
   * which shops; and Hatti's names, by city.
   */
  async review(
    courier: string,
    limit = 500,
  ): Promise<{ shops: ShopsCityNames[]; hatti: HattiCityName[] }> {
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{
        city_key: string;
        city: string;
        courier_city: string;
        shops: number;
      }>(sql`
        SELECT city_key, min(city) AS city, courier_city, count(DISTINCT shop_id)::int AS shops
          FROM logistics.shop_courier_cities
         WHERE courier = ${courier}
         GROUP BY city_key, courier_city`);
      const byCity = new Map<string, ShopsCityNames>();
      for (const row of rows) {
        const entry = byCity.get(row.city_key) ?? {
          cityKey: row.city_key,
          city: row.city,
          names: [],
          shared: null,
        };
        entry.names.push({ courierCity: row.courier_city, shops: row.shops });
        byCity.set(row.city_key, entry);
      }
      const shops = [...byCity.values()];
      for (const entry of shops) {
        entry.names.sort((a, b) => b.shops - a.shops || a.courierCity.localeCompare(b.courierCity));
        const given = entry.names.reduce((sum, name) => sum + name.shops, 0);
        const alike = new Set(entry.names.map((name) => cityKey(name.courierCity))).size === 1;
        entry.shared = given >= SHARED_CITY_SHOPS && alike ? entry.names[0]!.courierCity : null;
      }
      shops.sort((a, b) => total(b) - total(a) || a.cityKey.localeCompare(b.cityKey));
      const { rows: hatti } = await tx.execute<{ city: string; courier_city: string }>(sql`
        SELECT city, courier_city FROM logistics.courier_cities
         WHERE courier = ${courier}
         ORDER BY lower(city), city`);
      return {
        shops: shops.slice(0, limit),
        hatti: hatti.map((row) => ({ city: row.city, courierCity: row.courier_city })),
      };
    });
  }

  /**
   * Keeps Hatti's name for `city` with `courier`, for every shop, in place of any it had for the
   * city in any case: it comes before any name shops agree on, so it settles a city they named
   * wrong. Throws with what is wrong with it.
   */
  async keep(courier: string, city: string, courierCity: string): Promise<void> {
    const [written, named] = [tidy(city), tidy(courierCity)];
    if (!COURIER.test(courier)) throw new Error(`No courier is called ${courier}`);
    for (const [what, value] of [
      ['city', written],
      ["courier's name", named],
    ] as const) {
      if (cityKey(value) === '') throw new Error(`The ${what} is blank`);
      if (value.length > COURIER_CITY_LIMITS.city) {
        throw new Error(`The ${what} is longer than ${COURIER_CITY_LIMITS.city} characters`);
      }
    }
    await this.db.system(async (tx) => {
      await tx.execute(sql`
        DELETE FROM logistics.courier_cities
         WHERE courier = ${courier} AND lower(city) = lower(${written})`);
      await tx.execute(sql`
        INSERT INTO logistics.courier_cities (courier, city, courier_city)
        VALUES (${courier}, ${written}, ${named})`);
    });
  }

  /** Forgets Hatti's name for `city` with `courier`: whether it had one. */
  async forget(courier: string, city: string): Promise<boolean> {
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute(sql`
        DELETE FROM logistics.courier_cities
         WHERE courier = ${courier} AND lower(city) = lower(${tidy(city)})
        RETURNING city`);
      return rows.length > 0;
    });
  }
}

function total(entry: ShopsCityNames): number {
  return entry.names.reduce((sum, name) => sum + name.shops, 0);
}

/** A name as kept: its spaces collapsed, none at its ends. */
function tidy(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
