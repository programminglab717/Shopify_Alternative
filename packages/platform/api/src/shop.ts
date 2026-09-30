import type { Tx } from '@hatti/db';
import { eq } from 'drizzle-orm';
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';

// The shop directory belongs to the control plane, which replicates it read-only into cells.
// Request code reads its own shop's entry; row-level security shows it no other.
const shops = pgSchema('control').table('shops', {
  id: uuid('id').notNull(),
  name: text('name').notNull(),
  handle: text('handle').notNull(),
  status: text('status').$type<ShopStatus>().notNull(),
  currency: text('currency').notNull(),
  timezone: text('timezone').notNull(),
});

export type ShopStatus = 'active' | 'suspended' | 'closed';

/** A shop as the shop directory has it. */
export interface ShopProfile {
  id: string;
  name: string;
  /** Names its storefront on the platform's domain, e.g. "zari" for zari.hatti.pk. */
  handle: string;
  status: ShopStatus;
  /** ISO 4217, e.g. PKR. */
  currency: string;
  /** IANA time zone, e.g. Asia/Karachi. */
  timezone: string;
}

/** The shop's entry in the shop directory, read in a tenant transaction of that shop. */
export async function shopProfile(tx: Tx, shopId: string): Promise<ShopProfile> {
  const [row] = await tx.select().from(shops).where(eq(shops.id, shopId));
  if (!row) throw new Error(`Shop ${shopId} not found`);
  return row;
}
