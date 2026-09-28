import type { Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import type { PkProvinceCode } from '@hatti/pk';
import { and, eq } from 'drizzle-orm';
import { InventoryEvents, type LocationCreatedPayload } from './events.js';
import type { LocationRecord } from './records.js';
import { FIRST_LOCATION_NAME } from './rules.js';
import { locations, type LocationRow } from './schema.js';

export function toLocationRecord(row: LocationRow): LocationRecord {
  return {
    id: row.id,
    name: row.name,
    address: {
      address1: row.address1,
      address2: row.address2,
      city: row.city,
      provinceCode: row.provinceCode as PkProvinceCode | null,
      zip: row.zip,
      phone: row.phone,
    },
    isPrimary: row.isPrimary,
    isActive: row.isActive,
    fulfillsOnlineOrders: row.fulfillsOnlineOrders,
    deactivatedAt: row.deactivatedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A location row as `to_jsonb(loc)` renders it, for queries that embed the location. */
export interface LocationJson {
  id: string;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province_code: string | null;
  zip: string | null;
  phone: string | null;
  is_primary: boolean;
  is_active: boolean;
  fulfills_online_orders: boolean;
  deactivated_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function locationFromJson(json: LocationJson): LocationRecord {
  return {
    id: json.id,
    name: json.name,
    address: {
      address1: json.address1,
      address2: json.address2,
      city: json.city,
      provinceCode: json.province_code as PkProvinceCode | null,
      zip: json.zip,
      phone: json.phone,
    },
    isPrimary: json.is_primary,
    isActive: json.is_active,
    fulfillsOnlineOrders: json.fulfills_online_orders,
    deactivatedAt: json.deactivated_at === null ? null : new Date(json.deactivated_at),
    version: json.version,
    createdAt: new Date(json.created_at),
    updatedAt: new Date(json.updated_at),
  };
}

/**
 * The shop's primary location. A shop that has none has no locations at all, so this creates its
 * first, "Main location". Safe to race: the unique index on the primary decides.
 */
export async function ensurePrimaryLocation(tx: Tx, shopId: string): Promise<LocationRecord> {
  const primary = () =>
    tx
      .select()
      .from(locations)
      .where(and(eq(locations.shopId, shopId), eq(locations.isPrimary, true)));
  const [existing] = await primary();
  if (existing) return toLocationRecord(existing);

  const created = await tx
    .insert(locations)
    .values({ shopId, id: newId(), name: FIRST_LOCATION_NAME, isPrimary: true })
    .onConflictDoNothing()
    .returning();
  if (created[0]) {
    await appendEvent<LocationCreatedPayload>(tx, shopId, {
      type: InventoryEvents.LocationCreated,
      aggregateType: 'location',
      aggregateId: created[0].id,
      payload: { name: created[0].name, isPrimary: true },
    });
    return toLocationRecord(created[0]);
  }
  const [raced] = await primary();
  if (!raced) throw new Error('No primary location after creating one');
  return toLocationRecord(raced);
}
