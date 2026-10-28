import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { toMajorString } from '@hatti/money';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DarazClient, DarazError, type DarazOrder, type DarazSkuUpdate } from './daraz-client.js';
import { OrderService } from './order.service.js';

// Daraz sync (CH-06, ADR-875): a shop connects its Daraz Seller Center account through Daraz's
// Open Platform, and Hatti keeps the two in step. The shop lists its products on Daraz itself,
// with the SKUs they have here; Hatti gives Daraz each SKU's stock at the location the account
// sells from, and its price where the shop asks, sending only what changed; and brings Daraz's
// new orders in as the shop's own, paid through Daraz, their stock taken here as any order's, each
// once, and cancels them here when Daraz does. An order naming SKUs the shop has none of, or an
// address it can't take, is left out, and said so.

/** Where Daraz's client is bound, by the host that has Daraz's app key; none without it. */
export const DARAZ_CLIENT = Symbol('DARAZ_CLIENT');

export const DARAZ_LIMITS = {
  /** Pages of 100 orders read at a sync. */
  orderPages: 10,
  /** SKUs Daraz takes a call. */
  skusPerCall: 20,
  /** How long a connect link's state lasts. */
  stateMs: 30 * 60_000,
  /** Orders read again before the last read's end, for those Daraz kept back a moment. */
  overlapMs: 5 * 60_000,
} as const;

/** Daraz's statuses of an order still to be sent, which come in as orders here. */
const NEW_STATUSES = new Set(['pending', 'unpaid', 'packed', 'repacked', 'ready_to_ship']);

/** The shop's Daraz account, as the Admin API shows it: never its tokens. */
export interface DarazAccountRecord {
  account: string;
  sellerId: string | null;
  locationId: string;
  syncPrices: boolean;
  syncedAt: Date | null;
  lastError: string | null;
  connectedAt: Date;
  /** Daraz orders left out, as their SKUs or address could not be taken. */
  leftOut: { darazOrderId: string; error: string; at: Date }[];
}

/** What a sync did. */
export interface DarazSyncResult {
  imported: number;
  cancelled: number;
  leftOut: number;
  pushed: number;
}

type AccountRow = {
  account: string;
  seller_id: string | null;
  access_token: string;
  refresh_token: string;
  access_expires_at: string | Date;
  location_id: string;
  sync_prices: boolean;
  orders_read_to: string | Date;
  synced_at: string | Date | null;
  last_error: string | null;
  connected_at: string | Date;
};

const sealedFor = (shopId: string, what: 'access' | 'refresh') => `daraz-${what}:${shopId}`;

/** The worker's caller: Hatti itself, as an app that is no app's. */
const workerOf = (shopId: string): TenantContext => ({
  shopId,
  currency: 'PKR',
  scopes: new Set(),
  actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
});

async function accountIn(tx: Tx, shopId: string, lock = false): Promise<AccountRow | null> {
  const { rows } = await tx.execute<AccountRow>(sql`
    SELECT account, seller_id, access_token, refresh_token, access_expires_at, location_id,
           sync_prices, orders_read_to, synced_at, last_error, connected_at
      FROM orders.daraz_accounts WHERE shop_id = ${shopId}
      ${lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

@Injectable()
export class DarazService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderService,
    private readonly variants: VariantService,
    private readonly inventory: InventoryService,
    private readonly locations: LocationService,
    @Optional() @Inject(SecretBox) private readonly box?: SecretBox | null,
    @Optional() @Inject(DARAZ_CLIENT) private readonly client?: DarazClient | null,
  ) {}

  /** Whether shops may connect Daraz here: the host has Daraz's app key, and keys to seal with. */
  get available(): boolean {
    return Boolean(this.client && this.box);
  }

  async account(tenant: TenantContext): Promise<DarazAccountRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await accountIn(tx, tenant.shopId);
      if (!row) return null;
      const { rows: left } = await tx.execute<{
        daraz_order_id: string;
        error: string;
        updated_at: string | Date;
      }>(sql`
        SELECT daraz_order_id, error, updated_at FROM orders.daraz_orders
         WHERE shop_id = ${tenant.shopId} AND order_id IS NULL AND error IS NOT NULL
         ORDER BY updated_at DESC LIMIT 20`);
      return {
        account: row.account,
        sellerId: row.seller_id,
        locationId: row.location_id,
        syncPrices: row.sync_prices,
        syncedAt: toDateOrNull(row.synced_at),
        lastError: row.last_error,
        connectedAt: toDate(row.connected_at),
        leftOut: left.map((each) => ({
          darazOrderId: each.daraz_order_id,
          error: each.error,
          at: toDate(each.updated_at),
        })),
      };
    });
  }

  /** Where the shop is sent to authorise Hatti on Daraz, back to `redirectUri`; null unset. */
  connectUrl(tenant: TenantContext, redirectUri: string, now: Date = new Date()): string | null {
    if (!this.client || !this.box) return null;
    const state = this.box.encrypt(
      JSON.stringify({ s: tenant.shopId, e: now.getTime() + DARAZ_LIMITS.stateMs }),
      'daraz-state',
    );
    return this.client.authorizeUrl(redirectUri, state);
  }

  /**
   * The seller's authorisation `code`, with the `state` the connect link carried, exchanged for
   * their tokens, kept sealed: the shop's Daraz account, selling from its primary location unless
   * told. Orders placed on Daraz from now on come in.
   */
  async connect(
    tenant: TenantContext,
    input: { code: string; state: string; locationId?: string | null },
    now: Date = new Date(),
  ): Promise<MutationResult<DarazAccountRecord>> {
    const { client, box } = this;
    if (!client || !box) return failOne(['code'], 'UNAVAILABLE', 'Daraz isn’t set up here');
    let state: { s?: unknown; e?: unknown };
    try {
      state = JSON.parse(box.decrypt(input.state, 'daraz-state').toString('utf8')) as typeof state;
    } catch {
      return failOne(['state'], 'INVALID', 'Start connecting Daraz again from the admin');
    }
    if (state.s !== tenant.shopId || typeof state.e !== 'number' || state.e < now.getTime()) {
      return failOne(['state'], 'INVALID', 'Start connecting Daraz again from the admin');
    }
    let tokens;
    try {
      tokens = await client.createToken(input.code, now);
    } catch (error) {
      return failOne(
        ['code'],
        'INVALID',
        `Daraz did not connect: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const locationId = input.locationId ?? (await this.locations.primary(tenant))?.id ?? null;
    const saved = await this.db.tenant(tenant.shopId, async (tx) => {
      if (!locationId) {
        return failOne<null>(['locationId'], 'NOT_FOUND', 'No such active location');
      }
      const location = (await this.locations.locationsOf(tx, tenant.shopId, [locationId])).get(
        locationId,
      );
      if (!location?.isActive) {
        return failOne<null>(['locationId'], 'NOT_FOUND', 'No such active location');
      }
      await tx.execute(sql`
        INSERT INTO orders.daraz_accounts
               (shop_id, account, seller_id, access_token, refresh_token, access_expires_at,
                refresh_expires_at, location_id, orders_read_to)
        VALUES (${tenant.shopId}, ${tokens.account.slice(0, 200)}, ${tokens.sellerId},
                ${box.encrypt(tokens.accessToken, sealedFor(tenant.shopId, 'access'))},
                ${box.encrypt(tokens.refreshToken, sealedFor(tenant.shopId, 'refresh'))},
                ${tokens.accessExpiresAt.toISOString()}, ${tokens.refreshExpiresAt.toISOString()},
                ${locationId}, ${now.toISOString()})
            ON CONFLICT (shop_id) DO UPDATE
           SET account = EXCLUDED.account, seller_id = EXCLUDED.seller_id,
               access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
               access_expires_at = EXCLUDED.access_expires_at,
               refresh_expires_at = EXCLUDED.refresh_expires_at,
               location_id = EXCLUDED.location_id, last_error = NULL`);
      return { ok: true as const, value: null };
    });
    if (!saved.ok) return saved;
    return { ok: true, value: (await this.account(tenant))! };
  }

  /** The location the account sells from, and whether Daraz's prices follow the shop's. */
  async update(
    tenant: TenantContext,
    input: { locationId?: string | null; syncPrices?: boolean | null },
  ): Promise<MutationResult<DarazAccountRecord>> {
    const updated = await this.db.tenant(tenant.shopId, async (tx) => {
      const row = await accountIn(tx, tenant.shopId, true);
      if (!row) return failOne<null>(['id'], 'NOT_FOUND', 'Daraz isn’t connected');
      if (input.locationId) {
        const location = (
          await this.locations.locationsOf(tx, tenant.shopId, [input.locationId])
        ).get(input.locationId);
        if (!location?.isActive) {
          return failOne<null>(['locationId'], 'NOT_FOUND', 'No such active location');
        }
      }
      await tx.execute(sql`
        UPDATE orders.daraz_accounts
           SET location_id = ${input.locationId ?? row.location_id},
               sync_prices = ${input.syncPrices ?? row.sync_prices}
         WHERE shop_id = ${tenant.shopId}`);
      // What Daraz has of each SKU is sent again from the new place, or with prices.
      await tx.execute(sql`DELETE FROM orders.daraz_listings WHERE shop_id = ${tenant.shopId}`);
      return { ok: true as const, value: null };
    });
    if (!updated.ok) return updated;
    return { ok: true, value: (await this.account(tenant))! };
  }

  /** Forgets the account and its tokens; the orders it brought in stay the shop's. */
  async disconnect(tenant: TenantContext): Promise<boolean> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rowCount } = await tx.execute(sql`
        DELETE FROM orders.daraz_accounts WHERE shop_id = ${tenant.shopId}`);
      await tx.execute(sql`DELETE FROM orders.daraz_listings WHERE shop_id = ${tenant.shopId}`);
      return (rowCount ?? 0) > 0;
    });
  }

  /** The shops with Daraz connected, for the worker's syncs. */
  async connectedShops(): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM orders.daraz_accounts ORDER BY synced_at NULLS FIRST, shop_id`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * One sync of the shop's Daraz account: its tokens renewed when they near their end, Daraz's
   * orders since the last read brought in or cancelled, and what changed of its SKUs' stock and
   * prices given to Daraz. What failed is kept as the account's last error, for the admin.
   */
  async sync(shopId: string, now: Date = new Date()): Promise<DarazSyncResult | null> {
    const { client, box } = this;
    if (!client || !box) return null;
    const row = await this.db.tenant(shopId, (tx) => accountIn(tx, shopId));
    if (!row) return null;
    const result: DarazSyncResult = { imported: 0, cancelled: 0, leftOut: 0, pushed: 0 };
    try {
      const token = await this.#accessToken(shopId, row, now);
      await this.#readOrders(shopId, row, token, now, result);
      await this.#pushStock(shopId, row, token, result);
      await this.db.tenant(shopId, (tx) =>
        tx.execute(sql`
          UPDATE orders.daraz_accounts SET synced_at = ${now.toISOString()}, last_error = NULL
           WHERE shop_id = ${shopId}`),
      );
    } catch (error) {
      if (!(error instanceof DarazError)) throw error;
      await this.db.tenant(shopId, (tx) =>
        tx.execute(sql`
          UPDATE orders.daraz_accounts SET last_error = ${error.message.slice(0, 500)}
           WHERE shop_id = ${shopId}`),
      );
    }
    return result;
  }

  /** The seller's access token, renewed and kept again when it ends within the hour. */
  async #accessToken(shopId: string, row: AccountRow, now: Date): Promise<string> {
    const box = this.box!;
    if (toDate(row.access_expires_at).getTime() - now.getTime() > 3_600_000) {
      return box.decrypt(row.access_token, sealedFor(shopId, 'access')).toString('utf8');
    }
    const refresh = box.decrypt(row.refresh_token, sealedFor(shopId, 'refresh')).toString('utf8');
    const tokens = await this.client!.refreshToken(refresh, now);
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE orders.daraz_accounts
           SET access_token = ${box.encrypt(tokens.accessToken, sealedFor(shopId, 'access'))},
               refresh_token = ${box.encrypt(tokens.refreshToken, sealedFor(shopId, 'refresh'))},
               access_expires_at = ${tokens.accessExpiresAt.toISOString()},
               refresh_expires_at = ${tokens.refreshExpiresAt.toISOString()}
         WHERE shop_id = ${shopId}`),
    );
    return tokens.accessToken;
  }

  async #readOrders(
    shopId: string,
    row: AccountRow,
    token: string,
    now: Date,
    result: DarazSyncResult,
  ): Promise<void> {
    const client = this.client!;
    const after = new Date(toDate(row.orders_read_to).getTime() - DARAZ_LIMITS.overlapMs);
    const seen: DarazOrder[] = [];
    for (let page = 0; page < DARAZ_LIMITS.orderPages; page += 1) {
      const orders = await client.orders(token, after, page * 100);
      seen.push(...orders);
      if (orders.length < 100) break;
    }
    const known = await this.db.tenant(shopId, async (tx) => {
      if (seen.length === 0) return new Map<string, { orderId: string | null; status: string }>();
      const { rows } = await tx.execute<{
        daraz_order_id: string;
        order_id: string | null;
        status: string;
      }>(sql`
        SELECT daraz_order_id, order_id, status FROM orders.daraz_orders
         WHERE shop_id = ${shopId}
           AND daraz_order_id = ANY(${sql.param(seen.map((order) => order.orderId))}::text[])`);
      return new Map(
        rows.map((each) => [each.daraz_order_id, { orderId: each.order_id, status: each.status }]),
      );
    });
    const fresh = seen.filter(
      (order) => !known.has(order.orderId) && NEW_STATUSES.has(order.status),
    );
    // Daraz's cancellations of orders brought in: cancelled here too, while they can be.
    for (const order of seen) {
      const kept = known.get(order.orderId);
      if (!kept || order.status !== 'canceled' || kept.status === 'canceled') continue;
      if (kept.orderId) {
        const cancelled = await this.orders.cancel(workerOf(shopId), kept.orderId, {
          reason: 'customer',
          staffNote: `Cancelled on Daraz, order ${order.orderId}`,
        });
        if (cancelled.ok) result.cancelled += 1;
      }
      await this.db.tenant(shopId, (tx) =>
        tx.execute(sql`
          UPDATE orders.daraz_orders SET status = 'canceled', updated_at = now()
           WHERE shop_id = ${shopId} AND daraz_order_id = ${order.orderId}`),
      );
    }
    const items = [];
    for (let at = 0; at < fresh.length; at += 50) {
      items.push(
        ...(await client.orderItems(
          token,
          fresh.slice(at, at + 50).map((o) => o.orderId),
        )),
      );
    }
    for (const order of fresh) {
      const units = items.filter((item) => item.orderId === order.orderId);
      const bySku = new Map<string, { quantity: number; price: string }>();
      for (const unit of units) {
        const line = bySku.get(unit.sku);
        bySku.set(unit.sku, { quantity: (line?.quantity ?? 0) + 1, price: unit.paidPrice });
      }
      const outcome = await this.db.tenant(shopId, async (tx) => {
        const ids = await this.variants.idsBySkuIn(tx, shopId, [...bySku.keys()]);
        const missing = [...bySku.keys()].filter((sku) => !ids.has(sku));
        let orderId: string | null = null;
        let error: string | null = null;
        if (bySku.size === 0) error = 'Daraz gave the order no items';
        else if (missing.length > 0) {
          error = `The shop has no active product with SKU ${missing.join(', ')}`;
        } else {
          const placed = await this.orders.create(
            workerOf(shopId),
            {
              lineItems: [...bySku].map(([sku, line]) => ({
                variantId: ids.get(sku)!,
                quantity: line.quantity,
                price: line.price || null,
              })),
              shippingAddress: {
                name: order.address.name || 'Daraz customer',
                phone: order.address.phone,
                address1: order.address.address1,
                address2: order.address.address2,
                city: order.address.city,
              },
              paymentMethod: 'prepaid',
              locationId: row.location_id,
              note: `Daraz order ${order.orderId}, paid through Daraz`,
              tags: ['daraz'],
            },
            { tx, how: `from Daraz, order ${order.orderId}`, source: 'marketplace' },
          );
          if (placed.ok) orderId = placed.value.id;
          else error = placed.errors[0]?.message ?? 'It could not be placed';
        }
        await tx.execute(sql`
          INSERT INTO orders.daraz_orders (shop_id, daraz_order_id, order_id, status, error)
          VALUES (${shopId}, ${order.orderId}, ${orderId}, ${order.status},
                  ${error?.slice(0, 500) ?? null})
              ON CONFLICT (shop_id, daraz_order_id) DO NOTHING`);
        return orderId ? 'imported' : 'leftOut';
      });
      result[outcome] += 1;
    }
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE orders.daraz_accounts SET orders_read_to = ${now.toISOString()}
         WHERE shop_id = ${shopId}`),
    );
  }

  async #pushStock(
    shopId: string,
    row: AccountRow,
    token: string,
    result: DarazSyncResult,
  ): Promise<void> {
    const changed = await this.db.tenant(shopId, async (tx) => {
      const forSale = (await this.variants.forSaleIn(tx, shopId, 5_000)).filter(
        (variant) => variant.sku,
      );
      const available = await this.inventory.availableAt(
        tx,
        shopId,
        row.location_id,
        forSale.map((variant) => variant.variantId),
      );
      const { rows } = await tx.execute<{ sku: string; quantity: number; price: string | null }>(
        sql`SELECT sku, quantity, price::text FROM orders.daraz_listings WHERE shop_id = ${shopId}`,
      );
      const last = new Map(rows.map((each) => [each.sku, each]));
      const updates: (DarazSkuUpdate & { paisa: bigint })[] = [];
      for (const variant of forSale) {
        const quantity = available.get(variant.variantId);
        // Stock not counted here isn't Daraz's to be told.
        if (quantity === null || quantity === undefined) continue;
        const shown = Math.max(quantity, 0);
        const before = last.get(variant.sku!);
        const priceChanged = row.sync_prices && before?.price !== variant.price.toString();
        if (before && before.quantity === shown && !priceChanged) continue;
        updates.push({
          sku: variant.sku!,
          quantity: shown,
          paisa: variant.price,
          ...(row.sync_prices && {
            price: toMajorString({ amount: variant.price, currency: 'PKR' }),
          }),
        });
      }
      return updates;
    });
    for (let at = 0; at < changed.length; at += DARAZ_LIMITS.skusPerCall) {
      const batch = changed.slice(at, at + DARAZ_LIMITS.skusPerCall);
      const refused = new Map(
        (await this.client!.updatePriceQuantity(token, batch)).map((each) => [
          each.sku,
          each.error,
        ]),
      );
      await this.db.tenant(shopId, async (tx) => {
        for (const update of batch) {
          await tx.execute(sql`
            INSERT INTO orders.daraz_listings (shop_id, sku, quantity, price, error, pushed_at)
            VALUES (${shopId}, ${update.sku}, ${update.quantity},
                    ${row.sync_prices ? update.paisa : null},
                    ${refused.get(update.sku)?.slice(0, 500) ?? null}, now())
                ON CONFLICT (shop_id, sku) DO UPDATE
               SET quantity = EXCLUDED.quantity, price = EXCLUDED.price, error = EXCLUDED.error,
                   pushed_at = now()`);
        }
      });
      result.pushed += batch.length - refused.size;
    }
  }
}
