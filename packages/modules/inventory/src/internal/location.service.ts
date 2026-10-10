import {
  InputChecker,
  PlanAllowance,
  failOne,
  planLimitMessage,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, isForeignKeyViolation, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { findCity, findProvince, normalizeDigits, parsePkMobile } from '@hatti/pk';
import { Injectable, Optional } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  InventoryEvents,
  type LocationCreatedPayload,
  type LocationDeletedPayload,
  type LocationUpdatedPayload,
} from './events.js';
import { ensurePrimaryLocation, toLocationRecord } from './location-store.js';
import type { LocationRecord, Page } from './records.js';
import { LIMITS } from './rules.js';
import { levels, locations, type LocationRow } from './schema.js';

export interface LocationAddressInput {
  address1?: string | null;
  address2?: string | null;
  /** Known cities are spelled the standard way: "lhr" becomes "Lahore". */
  city?: string | null;
  /** A province or territory: code ("PB"), name ("Punjab") or alias ("KPK"). From the city if left out. */
  province?: string | null;
  /** Five-digit postcode. */
  zip?: string | null;
  /** Mobile number, for courier pickups; stored as +923001234567. */
  phone?: string | null;
}

export interface LocationAddInput {
  name: string;
  address?: LocationAddressInput | null;
  /** Default true. */
  fulfillsOnlineOrders?: boolean | null;
}

/** Fields left out stay as they are; null or blank clears an address field. */
export interface LocationEditInput {
  name?: string | null;
  address?: LocationAddressInput | null;
  fulfillsOnlineOrders?: boolean | null;
}

export interface ListLocationsOptions {
  first: number;
  after?: string | null;
  includeInactive?: boolean;
}

type AddressColumns = Partial<
  Pick<LocationRow, 'address1' | 'address2' | 'city' | 'provinceCode' | 'zip' | 'phone'>
>;

/** Checks an address; returns the columns it sets. Fields left out are left out. */
function checkAddress(
  check: InputChecker,
  field: string[],
  input: LocationAddressInput | null | undefined,
): AddressColumns {
  const columns: AddressColumns = {};
  if (!input) return columns;
  const text = (name: 'address1' | 'address2' | 'city', value: string | null | undefined) => {
    if (value !== undefined) {
      columns[name] = check.text([...field, name], value, { max: LIMITS.addressLine });
    }
  };
  text('address1', input.address1);
  text('address2', input.address2);
  text('city', input.city);
  const city = columns.city ? findCity(columns.city) : null;
  if (city) columns.city = city.name;

  if (input.province !== undefined) {
    const value = input.province?.trim() ?? '';
    columns.provinceCode = value === '' ? null : findProvince(value);
    if (value !== '' && columns.provinceCode === null) {
      check.add(
        [...field, 'province'],
        'INVALID',
        'must be a province or territory of Pakistan, like Punjab or KPK',
      );
    }
  } else if (city) {
    columns.provinceCode = city.province;
  }

  if (input.zip !== undefined) {
    const zip = normalizeDigits(input.zip?.trim() ?? '');
    columns.zip = zip === '' ? null : zip;
    if (zip !== '' && !/^[0-9]{5}$/.test(zip)) {
      check.add([...field, 'zip'], 'INVALID', 'must be a five-digit postcode, like 54000');
    }
  }
  if (input.phone !== undefined) {
    const phone = input.phone?.trim() ?? '';
    const mobile = phone === '' ? null : parsePkMobile(phone);
    columns.phone = mobile?.e164 ?? null;
    if (phone !== '' && !mobile) {
      check.add(
        [...field, 'phone'],
        'INVALID',
        'must be a Pakistani mobile number, like 0300 1234567',
      );
    }
  }
  return columns;
}

const NAME_TAKEN = 'A location with this name already exists';

/**
 * Where stock is kept. A shop always has a primary location once it has any, and the first is
 * created, as "Main location", the first time something needs one. Deactivating a location takes
 * it out of stock totals and sales; only an empty location can be deactivated, and only one that
 * never held stock can be deleted.
 */
@Injectable()
export class LocationService {
  constructor(
    private readonly db: Database,
    /** The shop's plan's limit on locations (ADR-154); without it, the platform's alone. */
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  /** Locations in the order they were added, the first being primary. */
  async list(tenant: TenantContext, options: ListLocationsOptions): Promise<Page<LocationRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await ensurePrimaryLocation(tx, tenant.shopId);
      const conditions: SQL[] = [eq(locations.shopId, tenant.shopId)];
      if (!options.includeInactive) conditions.push(eq(locations.isActive, true));
      if (options.after) conditions.push(gt(locations.id, options.after));
      const rows = await tx
        .select()
        .from(locations)
        .where(and(...conditions))
        .orderBy(asc(locations.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toLocationRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<LocationRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(locations)
        .where(and(eq(locations.shopId, tenant.shopId), eq(locations.id, id)));
      return row ? toLocationRecord(row) : null;
    });
  }

  /** The primary location, created if the shop has none yet. */
  primary(tenant: TenantContext): Promise<LocationRecord> {
    return this.db.tenant(tenant.shopId, (tx) => ensurePrimaryLocation(tx, tenant.shopId));
  }

  /** Those of `ids` that are the shop's locations, active or not; for batch loaders. */
  getMany(tenant: TenantContext, ids: readonly string[]): Promise<Map<string, LocationRecord>> {
    if (ids.length === 0) return Promise.resolve(new Map());
    return this.db.tenant(tenant.shopId, (tx) => this.locationsOf(tx, tenant.shopId, ids));
  }

  /** Like {@link primary}, in another module's tenant transaction `tx`. */
  primaryOf(tx: Tx, shopId: string): Promise<LocationRecord> {
    return ensurePrimaryLocation(tx, shopId);
  }

  /**
   * Where an order's goods ship from when no one says (INV-10, ADR-355): the first active location
   * that fulfils online orders and has every tracked one of `lines` for sale there, the primary
   * first, then by name; the primary where none has them all. Read without locks: committing the
   * stock checks it again.
   */
  async forOrderIn(
    tx: Tx,
    shopId: string,
    lines: readonly { variantId: string; quantity: number }[],
  ): Promise<LocationRecord> {
    const wanted = new Map<string, number>();
    for (const line of lines) {
      wanted.set(line.variantId, (wanted.get(line.variantId) ?? 0) + line.quantity);
    }
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT loc.id
        FROM inventory.locations loc
       WHERE loc.shop_id = ${shopId} AND loc.is_active AND loc.fulfills_online_orders
         AND NOT EXISTS (
               SELECT 1
                 FROM unnest(${sql.param([...wanted.keys()])}::uuid[],
                             ${sql.param([...wanted.values()])}::int[]) AS want(variant_id, quantity)
                 JOIN inventory.items i
                   ON i.shop_id = loc.shop_id AND i.variant_id = want.variant_id AND i.tracked
                 LEFT JOIN inventory.levels l
                   ON l.shop_id = loc.shop_id AND l.location_id = loc.id
                  AND l.variant_id = want.variant_id
                WHERE coalesce(l.available, 0) < want.quantity)
       ORDER BY loc.is_primary DESC, lower(loc.name), loc.id
       LIMIT 1`);
    const found = rows[0] && (await this.locationsOf(tx, shopId, [rows[0].id])).get(rows[0].id);
    return found ?? this.primaryOf(tx, shopId);
  }

  /** Like {@link getMany}, in another module's tenant transaction `tx`. */
  async locationsOf(
    tx: Tx,
    shopId: string,
    ids: readonly string[],
  ): Promise<Map<string, LocationRecord>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.shopId, shopId), inArray(locations.id, [...new Set(ids)])));
    return new Map(rows.map((row) => [row.id, toLocationRecord(row)]));
  }

  async add(
    tenant: TenantContext,
    input: LocationAddInput,
  ): Promise<MutationResult<LocationRecord>> {
    const check = new InputChecker();
    const name = check.text(['input', 'name'], input.name, { required: true, max: LIMITS.name });
    const address = checkAddress(check, ['input', 'address'], input.address);
    if (!check.ok || name === null) return { ok: false, errors: check.errors };
    const planned = await this.allowance?.limitOf(tenant.shopId, 'locations');

    const attempt = () =>
      this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<LocationRecord>> => {
        const [counts] = await tx
          .select({
            total: count(),
            primaries: sql<number>`count(*) FILTER (WHERE ${locations.isPrimary})::int`,
          })
          .from(locations)
          .where(eq(locations.shopId, tenant.shopId));
        if ((counts?.total ?? 0) >= LIMITS.locations) {
          return failOne(
            ['input'],
            'TOO_MANY',
            `A shop can have at most ${LIMITS.locations} locations`,
          );
        }
        // Its plan's, which a location the shop's first stock made counts against too.
        if (planned && (counts?.total ?? 0) >= planned.limit) {
          return failOne(['input'], 'TOO_MANY', planLimitMessage(planned, 'location', 'locations'));
        }
        if (await this.#nameTaken(tx, tenant.shopId, name)) {
          return failOne(['input', 'name'], 'TAKEN', NAME_TAKEN);
        }
        const [row] = await tx
          .insert(locations)
          .values({
            shopId: tenant.shopId,
            id: newId(),
            name,
            ...address,
            isPrimary: (counts?.primaries ?? 0) === 0,
            fulfillsOnlineOrders: input.fulfillsOnlineOrders ?? true,
          })
          .returning();
        await appendEvent<LocationCreatedPayload>(tx, tenant.shopId, {
          type: InventoryEvents.LocationCreated,
          aggregateType: 'location',
          aggregateId: row!.id,
          payload: { name: row!.name, isPrimary: row!.isPrimary },
        });
        return { ok: true, value: toLocationRecord(row!) };
      });
    try {
      return await attempt();
    } catch (error) {
      if (isUniqueViolation(error, 'locations_name_key')) {
        return failOne(['input', 'name'], 'TAKEN', NAME_TAKEN);
      }
      // Another request made the shop's first location at the same time: this one is not primary.
      if (isUniqueViolation(error, 'locations_primary_key')) return attempt();
      throw error;
    }
  }

  async edit(
    tenant: TenantContext,
    id: string,
    input: LocationEditInput,
  ): Promise<MutationResult<LocationRecord>> {
    const check = new InputChecker();
    const name =
      input.name === undefined
        ? undefined
        : check.text(['input', 'name'], input.name, { required: true, max: LIMITS.name });
    const address = checkAddress(check, ['input', 'address'], input.address);
    if (input.fulfillsOnlineOrders === null) {
      check.add(['input', 'fulfillsOnlineOrders'], 'BLANK', "can't be blank");
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const row = await this.#lock(tx, tenant.shopId, id);
        if (!row) return failOne(['id'], 'NOT_FOUND', 'Location not found');
        const next: Partial<LocationRow> = { ...address };
        if (name) next.name = name;
        if (input.fulfillsOnlineOrders !== undefined && input.fulfillsOnlineOrders !== null) {
          next.fulfillsOnlineOrders = input.fulfillsOnlineOrders;
        }
        const changed = (Object.keys(next) as (keyof LocationRow)[]).filter(
          (key) => next[key] !== row[key],
        );
        if (changed.length === 0) return { ok: true, value: toLocationRecord(row) };
        if (
          name &&
          name.toLowerCase() !== row.name.toLowerCase() &&
          (await this.#nameTaken(tx, tenant.shopId, name))
        ) {
          return failOne(['input', 'name'], 'TAKEN', NAME_TAKEN);
        }
        return {
          ok: true,
          value: await this.#update(tx, tenant.shopId, row, next, changed.map(String)),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'locations_name_key')) {
        return failOne(['input', 'name'], 'TAKEN', NAME_TAKEN);
      }
      throw error;
    }
  }

  /** Takes a location out of use. It must hold no stock, and not be the primary location. */
  async deactivate(tenant: TenantContext, id: string): Promise<MutationResult<LocationRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      // Waits for stock changes at this location to finish, and holds off new ones.
      const row = await this.#lock(tx, tenant.shopId, id);
      if (!row) return failOne(['locationId'], 'NOT_FOUND', 'Location not found');
      if (!row.isActive) return { ok: true, value: toLocationRecord(row) };
      if (row.isPrimary) {
        return failOne(['locationId'], 'INVALID', "The primary location can't be deactivated");
      }
      const [stocked] = await tx
        .select({ variantId: levels.variantId })
        .from(levels)
        .where(
          and(
            eq(levels.shopId, tenant.shopId),
            eq(levels.locationId, id),
            sql`(${levels.onHand} <> 0 OR ${levels.committed} <> 0 OR ${levels.reserved} <> 0)`,
          ),
        )
        .limit(1);
      if (stocked) {
        return failOne(
          ['locationId'],
          'IN_USE',
          'The location still has stock, orders or checkouts waiting on it; move or adjust its stock first',
        );
      }
      const value = await this.#update(
        tx,
        tenant.shopId,
        row,
        { isActive: false, deactivatedAt: sql`now()` },
        ['isActive'],
      );
      return { ok: true, value };
    });
  }

  async activate(tenant: TenantContext, id: string): Promise<MutationResult<LocationRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#lock(tx, tenant.shopId, id);
      if (!row) return failOne(['locationId'], 'NOT_FOUND', 'Location not found');
      if (row.isActive) return { ok: true, value: toLocationRecord(row) };
      const value = await this.#update(
        tx,
        tenant.shopId,
        row,
        { isActive: true, deactivatedAt: null },
        ['isActive'],
      );
      return { ok: true, value };
    });
  }

  /** Deletes a location that never held stock. Others can be deactivated instead. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const row = await this.#lock(tx, tenant.shopId, id);
        if (!row) return failOne(['locationId'], 'NOT_FOUND', 'Location not found');
        if (row.isPrimary) {
          return failOne(['locationId'], 'INVALID', "The primary location can't be deleted");
        }
        await tx
          .delete(locations)
          .where(and(eq(locations.shopId, tenant.shopId), eq(locations.id, id)));
        await appendEvent<LocationDeletedPayload>(tx, tenant.shopId, {
          type: InventoryEvents.LocationDeleted,
          aggregateType: 'location',
          aggregateId: id,
          payload: { name: row.name },
        });
        return { ok: true, value: { id } };
      });
    } catch (error) {
      // Its stock history refers to it.
      if (isForeignKeyViolation(error)) {
        return failOne(
          ['locationId'],
          'IN_USE',
          'The location has stock history, so it can only be deactivated',
        );
      }
      throw error;
    }
  }

  #lock(tx: Tx, shopId: string, id: string): Promise<LocationRow | undefined> {
    return tx
      .select()
      .from(locations)
      .where(and(eq(locations.shopId, shopId), eq(locations.id, id)))
      .for('update')
      .then((rows) => rows[0]);
  }

  async #nameTaken(tx: Tx, shopId: string, name: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.shopId, shopId), sql`lower(${locations.name}) = lower(${name})`))
      .limit(1);
    return row !== undefined;
  }

  async #update(
    tx: Tx,
    shopId: string,
    row: LocationRow,
    next: PgUpdateSetSource<typeof locations>,
    changed: string[],
  ): Promise<LocationRecord> {
    const [updated] = await tx
      .update(locations)
      .set({ ...next, version: sql`${locations.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(locations.shopId, shopId), eq(locations.id, row.id)))
      .returning();
    await appendEvent<LocationUpdatedPayload>(tx, shopId, {
      type: InventoryEvents.LocationUpdated,
      aggregateType: 'location',
      aggregateId: row.id,
      payload: { changed, version: updated!.version },
    });
    return toLocationRecord(updated!);
  }
}
