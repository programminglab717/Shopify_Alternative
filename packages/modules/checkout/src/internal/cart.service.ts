import { VariantService } from '@hatti/catalog/public';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { InventoryService } from '@hatti/inventory/public';
import type { CartError, CartJson } from '@hatti/storefront-api';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  CART_DAYS,
  EMPTY_CART,
  applyAction,
  cartJson,
  variantsNamed,
  type CartAction,
  type CartContent,
  type VariantFacts,
} from './cart-lines.js';
import { carts } from './schema.js';

/** A cart's secret: 128 random bits in base64url, as customers' links have. */
const TOKEN_BYTES = 16;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** Expired carts deleted each time a shop gets a new one. */
const SWEEP = 100;

export type CartResult =
  | { ok: true; cart: CartJson; token: string | null; added: string[] }
  | { ok: false; error: CartError };

/**
 * Shoppers' carts (ADR-042), which storefronts change for them. A cart keeps variants, quantities
 * and what the shopper typed; prices and stock are read from the catalog and inventory each time,
 * in the same transaction. A cart is found by its secret, of which only the SHA-256 is kept, and
 * lasts {@link CART_DAYS} days after its last change.
 */
@Injectable()
export class CartService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly inventory: InventoryService,
  ) {}

  /** The shop's cart `token` names, priced now; null when it names none, as once it expired. */
  async cart(shopId: string, token: string): Promise<CartJson | null> {
    const hash = hashOf(token);
    if (!hash) return null;
    return this.db.tenant(shopId, async (tx) => {
      const found = await this.#find(tx, shopId, hash, false);
      if (!found) return null;
      const facts = await this.#facts(
        tx,
        shopId,
        found.lines.map((line) => line.variantId),
      );
      return cartJson(found, facts);
    });
  }

  /**
   * Does `action` to the shop's cart `token` names, or else to a new cart with a secret of its
   * own: a token naming no cart, as once it expired, is never taken up. A new cart is kept only
   * once it holds something. Concurrent actions on a cart take turns.
   */
  async act(shopId: string, token: string | null, action: CartAction): Promise<CartResult> {
    return this.db.tenant(shopId, async (tx): Promise<CartResult> => {
      const hash = token === null ? null : hashOf(token);
      const found = hash ? await this.#find(tx, shopId, hash, true) : null;
      const current = found ?? EMPTY_CART;
      const facts = await this.#facts(tx, shopId, [
        ...current.lines.map((line) => line.variantId),
        ...variantsNamed(action),
      ]);
      const applied = applyAction(current, action, facts);
      if ('code' in applied) return { ok: false, error: applied };
      const { added, ...content } = applied;
      const cart = cartJson(content, facts);
      const expiresAt = sql`now() + ${`${CART_DAYS} days`}::interval`;
      if (found) {
        await tx
          .update(carts)
          .set({ ...content, updatedAt: sql`now()`, expiresAt })
          .where(and(eq(carts.shopId, shopId), eq(carts.id, found.id)));
        return { ok: true, cart, token, added };
      }
      if (isEmpty(content)) return { ok: true, cart, token: null, added };
      await this.#sweep(tx, shopId);
      const secret = secretToken('', TOKEN_BYTES);
      await tx
        .insert(carts)
        .values({ shopId, id: newId(), tokenHash: sha256(secret), ...content, expiresAt });
      return { ok: true, cart, token: secret, added };
    });
  }

  async #find(
    tx: Tx,
    shopId: string,
    hash: Buffer,
    lock: boolean,
  ): Promise<(CartContent & { id: string }) | null> {
    const query = tx
      .select({ id: carts.id, lines: carts.lines, note: carts.note, attributes: carts.attributes })
      .from(carts)
      .where(
        and(eq(carts.shopId, shopId), eq(carts.tokenHash, hash), gt(carts.expiresAt, sql`now()`)),
      );
    const [row] = lock ? await query.for('update') : await query;
    return row ?? null;
  }

  /** What the catalog and inventory say of each variant now; those not found are left out. */
  async #facts(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, VariantFacts>> {
    const snapshots = await this.variants.snapshotsOf(tx, shopId, [...new Set(variantIds)]);
    const sellable = await this.inventory.sellableOf(tx, shopId, [...snapshots.keys()]);
    return new Map(
      [...snapshots].map(([id, snapshot]) => [
        id,
        {
          productId: snapshot.productId,
          title: snapshot.productTitle,
          variantTitle: snapshot.variantTitle,
          sku: snapshot.sku,
          price: snapshot.price,
          grams: snapshot.weightGrams ?? 0,
          forSale: snapshot.productStatus === 'active',
          sellable: sellable.get(id) ?? null,
        },
      ]),
    );
  }

  /** Deletes some of the shop's expired carts, as it gets a new one. */
  async #sweep(tx: Tx, shopId: string): Promise<void> {
    await tx.execute(sql`
      DELETE FROM checkout.carts
       WHERE shop_id = ${shopId}
         AND id IN (SELECT id FROM checkout.carts
                     WHERE shop_id = ${shopId} AND expires_at < now()
                     LIMIT ${SWEEP})`);
  }
}

/** The digest to find a cart by; null for anything that cannot be a cart's secret. */
function hashOf(token: string): Buffer | null {
  return TOKEN.test(token) ? sha256(token) : null;
}

function isEmpty(cart: CartContent): boolean {
  return cart.lines.length === 0 && cart.note === '' && Object.keys(cart.attributes).length === 0;
}
