import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { findCity } from '@hatti/pk';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { cityKey, courierNameOf, nearestCityNames } from './city-names.js';
import {
  COURIERS,
  CourierAccountService,
  type OpenedCourierAccount,
} from './courier-accounts.service.js';
import type { CourierResult, Couriers } from './couriers.js';

/**
 * Where the courier's name for a city came from: the shop's own, Hatti's for every shop, the
 * courier's list of cities, or the city as written, by Pakistan's name for it where it has one.
 */
export const COURIER_CITY_SOURCES = ['shop', 'platform', 'list', 'written'] as const;
export type CourierCitySourceValue = (typeof COURIER_CITY_SOURCES)[number];

/** How long a city's names may be, and how many the shop keeps for a courier. */
export const COURIER_CITY_LIMITS = {
  city: 100,
  names: 1_000,
} as const;

/** How a city matched a courier's names for the cities it delivers to (SHP-03, ADR-233). */
export interface CourierCityMatch {
  /** The city as it was given. */
  city: string;
  /** The courier's name for it, as parcels to it are booked; null where its list names none. */
  courierCity: string | null;
  source: CourierCitySourceValue | null;
  /** The courier's names nearest to it, the nearest first, where its list names none. */
  suggestions: string[];
  /** Why the courier's list could not be had now, where it could not: the city goes as written. */
  listError: string | null;
}

/** The shop's own name for a city with a courier. */
export interface CourierCityNameRecord {
  courier: string;
  /** The city as staff gave it. */
  city: string;
  courierCity: string;
  updatedAt: Date;
}

export interface CourierCityNameInput {
  /** The account whose courier it is for. */
  accountId: string;
  /** The city as orders write it. */
  city: string;
  /** The courier's name for it; null forgets the shop's own. */
  courierCity?: string | null;
}

/** An account the courier's names are asked of: its courier, and the credentials to ask with. */
type AskingAccount = Pick<OpenedCourierAccount, 'courier' | 'credentials'>;

/**
 * Couriers' names for the cities parcels go to (SHP-03, ADR-233). A courier delivers to the
 * cities on its own list, written its own way: a parcel's city is the shop's own name for it with
 * the courier, else Hatti's for every shop, else the courier's list's, matched through Pakistan's
 * names for the city and their aliases. Where the list names none, the booking fails with its
 * nearest names, and staff choose the courier's name for the city: the shop keeps it for the
 * next parcel. A courier that publishes no list, or whose list cannot be had now, is given the
 * city as written, by Pakistan's name for it where it has one, and says at booking if it knows it
 * not.
 */
@Injectable()
export class CourierCityService {
  constructor(
    private readonly db: Database,
    private readonly accounts: CourierAccountService,
    @Inject(COURIERS) private readonly couriers: Couriers,
  ) {}

  /**
   * The courier's name for a parcel's `city`, booked with `account`: the worker's. Where the
   * courier's list names none, why not, with its nearest names, as the booking's error.
   */
  async courierCityOf(
    shopId: string,
    account: AskingAccount,
    city: string,
  ): Promise<CourierResult<string>> {
    const matched = await this.#match(shopId, account, city);
    if (matched.courierCity !== null) return { ok: true, value: matched.courierCity };
    if (matched.city === '') {
      return { ok: false, retry: false, message: "The order's address names no city" };
    }
    const name = this.couriers.of(account.courier)?.info.name ?? account.courier;
    const nearest =
      matched.suggestions.length > 0 ? `; its nearest: ${matched.suggestions.join(', ')}` : '';
    return {
      ok: false,
      retry: false,
      message:
        `${name} has no city named ${matched.city}${nearest}. ` +
        `Give ${name}'s name for the city, then book the order again`,
    };
  }

  /** How `city` matches the names of the account's courier, as a parcel to it would be booked. */
  async match(
    tenant: TenantContext,
    accountId: string,
    city: string,
  ): Promise<MutationResult<CourierCityMatch>> {
    if (city.trim().length > COURIER_CITY_LIMITS.city) {
      return failOne(
        ['city'],
        'TOO_LONG',
        `City is too long (maximum is ${COURIER_CITY_LIMITS.city} characters)`,
      );
    }
    const account = await this.#account(tenant.shopId, accountId);
    if (!account.ok) return account;
    return { ok: true, value: await this.#match(tenant.shopId, account.value, city) };
  }

  /** The shop's own names for cities with the account's courier, by city. */
  async names(
    tenant: TenantContext,
    accountId: string,
  ): Promise<MutationResult<CourierCityNameRecord[]>> {
    return this.db.tenant(
      tenant.shopId,
      async (tx): Promise<MutationResult<CourierCityNameRecord[]>> => {
        const courier = await courierOfIn(tx, tenant.shopId, accountId);
        if (courier === null)
          return failOne(['accountId'], 'NOT_FOUND', 'Courier account not found');
        const { rows } = await tx.execute<{
          courier: string;
          city: string;
          courier_city: string;
          updated_at: string | Date;
        }>(sql`
        SELECT courier, city, courier_city, updated_at FROM logistics.shop_courier_cities
         WHERE shop_id = ${tenant.shopId} AND courier = ${courier}
         ORDER BY city_key
         LIMIT ${COURIER_CITY_LIMITS.names}`);
        return {
          ok: true,
          value: rows.map((row) => ({
            courier: row.courier,
            city: row.city,
            courierCity: row.courier_city,
            updatedAt: toDate(row.updated_at),
          })),
        };
      },
    );
  }

  /**
   * Keeps the shop's own name for a city with the account's courier, for the city as orders
   * write it and Pakistan's name for it; or forgets it. A courier with a list of cities is given
   * a name on it, as it writes it. How the city matches the courier's names now.
   */
  async set(
    tenant: TenantContext,
    input: CourierCityNameInput,
  ): Promise<MutationResult<CourierCityMatch>> {
    const check = new InputChecker();
    const city = input.city.trim().replace(/\s+/g, ' ');
    let courierCity =
      input.courierCity === null || input.courierCity === undefined
        ? null
        : input.courierCity.trim().replace(/\s+/g, ' ');
    for (const [field, value] of [
      ['city', city],
      ['courierCity', courierCity],
    ] as const) {
      if (value === null) continue;
      if (cityKey(value) === '') check.add(['input', field], 'BLANK', "can't be blank");
      else if (value.length > COURIER_CITY_LIMITS.city) {
        check.add(
          ['input', field],
          'TOO_LONG',
          `is too long (maximum is ${COURIER_CITY_LIMITS.city} characters)`,
        );
      }
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const account = await this.#account(tenant.shopId, input.accountId, ['input', 'accountId']);
    if (!account.ok) return account;
    const { courier, credentials } = account.value;
    const adapter = this.couriers.of(courier)!;
    if (courierCity !== null && adapter.cities) {
      const listed = await adapter.cities(credentials);
      // A list that cannot be had now leaves the name as given: the courier says at booking.
      if (listed.ok) {
        const wanted = cityKey(courierCity);
        const named = listed.value.find((name) => cityKey(name) === wanted);
        if (named === undefined) {
          const nearest = nearestCityNames(courierCity, listed.value);
          return failOne(
            ['input', 'courierCity'],
            'NOT_FOUND',
            `${adapter.info.name} has no city named ${courierCity}` +
              (nearest.length > 0 ? `; its nearest: ${nearest.join(', ')}` : ''),
          );
        }
        courierCity = named;
      }
    }
    const key = cityKey(city);
    const kept = await this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<null>> => {
      if (courierCity === null) {
        const { rows } = await tx.execute<{ courier_city: string }>(sql`
            DELETE FROM logistics.shop_courier_cities
             WHERE shop_id = ${tenant.shopId} AND courier = ${courier} AND city_key = ${key}
            RETURNING courier_city`);
        if (rows.length > 0) {
          await audit(tx, tenant, input.accountId, 'courier_city.forgotten', {
            courier,
            city,
            courierCity: rows[0]!.courier_city,
          });
        }
        return { ok: true, value: null };
      }
      const { rows: counted } = await tx.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count FROM logistics.shop_courier_cities
           WHERE shop_id = ${tenant.shopId} AND courier = ${courier} AND city_key <> ${key}`);
      if ((counted[0]?.count ?? 0) >= COURIER_CITY_LIMITS.names) {
        return failOne(
          ['input', 'city'],
          'TOO_MANY',
          `The shop keeps ${COURIER_CITY_LIMITS.names} names of cities with a courier at most`,
        );
      }
      await tx.execute(sql`
          INSERT INTO logistics.shop_courier_cities (shop_id, courier, city_key, city, courier_city)
          VALUES (${tenant.shopId}, ${courier}, ${key}, ${city}, ${courierCity})
              ON CONFLICT (shop_id, courier, city_key)
              DO UPDATE SET city = EXCLUDED.city, courier_city = EXCLUDED.courier_city,
                            updated_at = now()`);
      await audit(tx, tenant, input.accountId, 'courier_city.named', {
        courier,
        city,
        courierCity,
      });
      return { ok: true, value: null };
    });
    if (!kept.ok) return kept;
    return { ok: true, value: await this.#match(tenant.shopId, account.value, city) };
  }

  /** The account, opened, if the shop has it and books with its courier here. */
  async #account(
    shopId: string,
    accountId: string,
    field: string[] = ['accountId'],
  ): Promise<MutationResult<OpenedCourierAccount>> {
    const account = await this.accounts.openedOf(shopId, accountId);
    if (!account) return failOne(field, 'NOT_FOUND', 'Courier account not found');
    if (account.archived) return failOne(field, 'INVALID', 'The courier account is archived');
    if (!this.couriers.of(account.courier)) {
      return failOne(field, 'INVALID', 'Shops no longer book with this courier here');
    }
    return { ok: true, value: account };
  }

  async #match(shopId: string, account: AskingAccount, city: string): Promise<CourierCityMatch> {
    const written = city.trim().replace(/\s+/g, ' ');
    const match: CourierCityMatch = {
      city: written,
      courierCity: null,
      source: null,
      suggestions: [],
      listError: null,
    };
    if (cityKey(written) === '') return match;
    const known = findCity(written)?.name ?? null;
    const named = await this.db.tenant(shopId, (tx) =>
      namedIn(tx, shopId, account.courier, written, known),
    );
    if (named) return { ...match, courierCity: named.courierCity, source: named.source };
    const adapter = this.couriers.of(account.courier);
    const listed = adapter?.cities ? await adapter.cities(account.credentials) : null;
    if (listed?.ok) {
      const found = courierNameOf(written, listed.value);
      return found === null
        ? { ...match, suggestions: nearestCityNames(written, listed.value) }
        : { ...match, courierCity: found, source: 'list' };
    }
    return {
      ...match,
      courierCity: known ?? written,
      source: 'written',
      listError: listed && !listed.ok ? listed.message : null,
    };
  }
}

/**
 * The name for `city` with `courier` kept by the shop, else by Hatti for every shop: kept for
 * the city as written, or for Pakistan's name for it, `known`; the shop's first, then the one
 * kept for the city as written.
 */
async function namedIn(
  tx: Tx,
  shopId: string,
  courier: string,
  city: string,
  known: string | null,
): Promise<{ courierCity: string; source: 'shop' | 'platform' } | null> {
  const keys = [...new Set([cityKey(city), ...(known ? [cityKey(known)] : [])])];
  const names = [...new Set([city.toLowerCase(), ...(known ? [known.toLowerCase()] : [])])];
  const { rows } = await tx.execute<{ courier_city: string; source: 'shop' | 'platform' }>(sql`
    SELECT courier_city, source FROM (
      SELECT courier_city, 'shop' AS source, 0 AS rank, city_key = ${cityKey(city)} AS exact
        FROM logistics.shop_courier_cities
       WHERE shop_id = ${shopId} AND courier = ${courier}
         AND city_key = ANY(${sql.param(keys)}::text[])
      UNION ALL
      SELECT courier_city, 'platform', 1, lower(city) = ${city.toLowerCase()}
        FROM logistics.courier_cities
       WHERE courier = ${courier} AND lower(city) = ANY(${sql.param(names)}::text[])
    ) named
    ORDER BY rank, exact DESC
    LIMIT 1`);
  const row = rows[0];
  return row ? { courierCity: row.courier_city, source: row.source } : null;
}

/** The account's courier, if the shop has it. */
async function courierOfIn(tx: Tx, shopId: string, accountId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ courier: string }>(sql`
    SELECT courier FROM logistics.courier_accounts WHERE shop_id = ${shopId} AND id = ${accountId}`);
  return rows[0]?.courier ?? null;
}

async function audit(
  tx: Tx,
  tenant: TenantContext,
  accountId: string,
  action: string,
  details: { courier: string; city: string; courierCity: string },
): Promise<void> {
  await recordAudit(tx, tenant.shopId, {
    action,
    subjectType: 'courierAccount',
    subjectId: accountId,
    ...actorColumnsOf(tenant.actor),
    details,
  });
}
