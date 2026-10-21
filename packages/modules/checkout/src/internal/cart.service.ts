import {
  VariantService,
  bundleSellable,
  bundlesOfVariantsIn,
  personalisationIn,
  type PersonalisationField,
} from '@hatti/catalog/public';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, runPrepared, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { InventoryService, preordersIn } from '@hatti/inventory/public';
import {
  chooseDiscounts,
  discountCodeIn,
  discountFor,
  runningAutomaticDiscountsIn,
  type DiscountCodeRecord,
} from '@hatti/pricing/public';
import type {
  CartAutomaticDiscountJson,
  CartDiscountJson,
  CartError,
  CartJson,
} from '@hatti/storefront-api';
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
  type StoredLine,
  type VariantFacts,
  answersOf,
  personalisationProblem,
} from './cart-lines.js';
import type { CodProduct } from './cod-rules.js';
import { orderItemsIn } from './discount-items.js';
import { carts } from './schema.js';

/** A cart's secret: 128 random bits in base64url, as customers' links have. */
const TOKEN_BYTES = 16;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

export type CartResult =
  | { ok: true; cart: CartJson; token: string | null; added: string[] }
  | { ok: false; error: CartError };

/** A cart as kept, with the discount code its shopper applied. */
export type KeptCart = CartContent & { id: string; discountCodes: string[] };

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
      return withDiscount(tx, shopId, await priced(tx, shopId, found, facts), found.discountCodes);
    });
  }

  /**
   * Does `action` to the shop's cart `token` names, or else to a new cart with a secret of its
   * own: a token naming no cart, as once it expired, is never taken up. A new cart is kept only
   * once it holds something, a discount code alone included. Concurrent actions on a cart take
   * turns.
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
      // What products made to order ask for, answered as their pages ask (ADR-691), and what
      // the answers add to the lines' prices (ADR-697).
      const answers = answersOf(current, action, facts);
      const asked = await askedOf(tx, shopId, facts, [...applied.lines, ...answers]);
      for (const answer of answers) {
        const fact = facts.get(answer.variantId);
        const fields = fact && asked.get(fact.productId);
        const problem =
          fields && personalisationProblem(answer.variantId, fact.title, fields, answer.properties);
        if (problem) return { ok: false, error: problem };
      }
      const { added, ...content } = applied;
      const discountCodes =
        action.kind === 'update' && action.discountCodes !== null
          ? action.discountCodes
          : (found?.discountCodes ?? []);
      const cart = await withDiscount(tx, shopId, cartJson(content, facts, asked), discountCodes);
      const expiresAt = sql`now() + ${`${CART_DAYS} days`}::interval`;
      if (found) {
        await tx
          .update(carts)
          .set({ ...content, discountCodes, updatedAt: sql`now()`, expiresAt })
          .where(and(eq(carts.shopId, shopId), eq(carts.id, found.id)));
        return { ok: true, cart, token, added };
      }
      if (isEmpty(content) && discountCodes.length === 0) {
        return { ok: true, cart, token: null, added };
      }
      const secret = secretToken('', TOKEN_BYTES);
      await tx.insert(carts).values({
        shopId,
        id: newId(),
        tokenHash: sha256(secret),
        ...content,
        discountCodes,
        expiresAt,
      });
      return { ok: true, cart, token: secret, added };
    });
  }

  /** The cart `token` names, in the caller's transaction `tx`; null when it names none. */
  async findIn(tx: Tx, shopId: string, token: string): Promise<KeptCart | null> {
    const hash = hashOf(token);
    return hash ? this.#find(tx, shopId, hash, false) : null;
  }

  /**
   * The cart with this ID, in the caller's transaction `tx`, locked while an order is placed from
   * it; null once it expired.
   */
  async cartIn(tx: Tx, shopId: string, id: string, lock = false): Promise<KeptCart | null> {
    const query = tx
      .select(KEPT)
      .from(carts)
      .where(and(eq(carts.shopId, shopId), eq(carts.id, id), gt(carts.expiresAt, sql`now()`)));
    const [row] = lock ? await query.for('update') : await query;
    return row ?? null;
  }

  /** `cart` priced now, with what its discount code takes off, in the caller's transaction `tx`. */
  async priceIn(tx: Tx, shopId: string, cart: KeptCart): Promise<CartJson> {
    const facts = await this.#facts(
      tx,
      shopId,
      cart.lines.map((line) => line.variantId),
    );
    return withDiscount(tx, shopId, await priced(tx, shopId, cart, facts), cart.discountCodes);
  }

  /**
   * The products of `cart`'s items, by their titles and with their tags as they are now, in the
   * caller's transaction `tx`: for the shop's rules for cash on delivery.
   */
  async productsIn(tx: Tx, shopId: string, cart: CartJson): Promise<CodProduct[]> {
    const snapshots = await this.variants.snapshotsOf(
      tx,
      shopId,
      cart.items.map((item) => item.variantId),
    );
    return cart.items.flatMap((item) => {
      const snapshot = snapshots.get(item.variantId);
      return snapshot ? [{ title: snapshot.productTitle, tags: snapshot.productTags }] : [];
    });
  }

  /**
   * Empties a cart whose order was placed, its discount code with it, in the caller's
   * transaction `tx`.
   */
  async emptyIn(tx: Tx, shopId: string, id: string): Promise<void> {
    await tx
      .update(carts)
      .set({ lines: [], note: '', attributes: {}, discountCodes: [], updatedAt: sql`now()` })
      .where(and(eq(carts.shopId, shopId), eq(carts.id, id)));
  }

  /**
   * Keeps `codes` as the discount codes the cart's shopper applied, in the caller's transaction
   * `tx`; whether they take anything off is checkout's to say.
   */
  async setDiscountCodesIn(tx: Tx, shopId: string, id: string, codes: string[]): Promise<void> {
    await tx
      .update(carts)
      .set({ discountCodes: codes, updatedAt: sql`now()` })
      .where(and(eq(carts.shopId, shopId), eq(carts.id, id)));
  }

  /**
   * Keeps `lines` as what the cart holds, in the caller's transaction `tx`, as checkout's page
   * adds or takes off its gift wrap (ADR-413); what is for sale is the cart's pricing's to say.
   */
  async setLinesIn(tx: Tx, shopId: string, id: string, lines: StoredLine[]): Promise<void> {
    await tx
      .update(carts)
      .set({ lines, updatedAt: sql`now()` })
      .where(and(eq(carts.shopId, shopId), eq(carts.id, id)));
  }

  /** What the catalog and inventory say of these variants now, in the caller's transaction `tx`. */
  factsIn(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, VariantFacts>> {
    return this.#facts(tx, shopId, variantIds);
  }

  /** The cart whose secret hashes to `hash`; prepared (ADR-111) when read, not locked. */
  async #find(tx: Tx, shopId: string, hash: Buffer, lock: boolean): Promise<KeptCart | null> {
    const query = tx
      .select(KEPT)
      .from(carts)
      .where(
        and(eq(carts.shopId, shopId), eq(carts.tokenHash, hash), gt(carts.expiresAt, sql`now()`)),
      );
    const [row] = lock ? await query.for('update') : await runPrepared(query);
    return row ?? null;
  }

  /** What the catalog and inventory say of each variant now; those not found are left out. */
  async #facts(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, VariantFacts>> {
    const snapshots = await this.variants.snapshotsOf(tx, shopId, [...new Set(variantIds)]);
    // A bundle sells as many as its parts' stock makes (ADR-410).
    const bundles = await bundlesOfVariantsIn(tx, shopId, [...snapshots.keys()]);
    const sellable = await this.inventory.sellableOf(tx, shopId, [
      ...snapshots.keys(),
      ...[...bundles.values()].flatMap((bundle) => bundle.components.map((part) => part.variantId)),
    ]);
    for (const [id, bundle] of bundles) sellable.set(id, bundleSellable(bundle, sellable));
    const preorders = await preordersIn(
      tx,
      shopId,
      [...snapshots.values()].map((snapshot) => snapshot.productId),
    );
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
          taxable: snapshot.taxable,
          taxCode: snapshot.taxCode,
          forSale: snapshot.productStatus === 'active',
          sellable: sellable.get(id) ?? null,
          preorderShipsOn: preorders.get(snapshot.productId),
        },
      ]),
    );
  }
}

/** The personalisation fields of the products of `lines`, those `facts` knows (ADR-689). */
function askedOf(
  tx: Tx,
  shopId: string,
  facts: ReadonlyMap<string, VariantFacts>,
  lines: readonly { variantId: string }[],
): Promise<Map<string, PersonalisationField[]>> {
  return personalisationIn(tx, shopId, [
    ...new Set(lines.flatMap((line) => facts.get(line.variantId)?.productId ?? [])),
  ]);
}

/** `cart` as the storefront shows it, its lines priced with what their answers add (ADR-697). */
async function priced(
  tx: Tx,
  shopId: string,
  cart: CartContent,
  facts: ReadonlyMap<string, VariantFacts>,
): Promise<CartJson> {
  return cartJson(cart, facts, await askedOf(tx, shopId, facts, cart.lines));
}

/**
 * `cart` with its discounts (ADR-063, ADR-515): the shop's automatic discounts it takes now, and
 * its code, `codes` being what the cart keeps, with what it takes off the items now or only that
 * it does not apply, as Shopify's cart says. Why not is checkout's to say, which counts the codes
 * tried there; a code the shop has and one it lacks look the same here, as does one set aside for
 * automatic discounts that take more off and don't combine with codes.
 */
async function withDiscount(
  tx: Tx,
  shopId: string,
  cart: CartJson,
  codes: readonly string[],
): Promise<CartJson> {
  const automatics = await runningAutomaticDiscountsIn(tx, shopId);
  const [typed] = codes;
  if (typed === undefined && automatics.length === 0) return cart;
  const record = typed === undefined ? null : await discountCodeIn(tx, shopId, typed);
  // Each on the items it is for (ADR-517).
  const items = await orderItemsIn(tx, shopId, cart, [record, ...automatics]);
  const works = record && discountFor(record, { ...items, shipping: 0n }).ok ? record : null;
  const chosen = chooseDiscounts(items, works, automatics);
  const automaticDiscounts: CartAutomaticDiscountJson[] = chosen.automatic.map((automatic) => ({
    title: automatic.title,
    kind: automatic.kind,
    value: automatic.kind === 'buy_x_get_y' ? Number(chosen.byAutomatic) : valueOf(automatic),
    amount: automatic.kind === 'free_shipping' ? 0 : Number(chosen.byAutomatic),
  }));
  const code = chosen.code;
  const discount: CartDiscountJson | null =
    typed === undefined
      ? null
      : code
        ? {
            code: code.code,
            applicable: true,
            kind: code.kind,
            value: code.kind === 'buy_x_get_y' ? Number(chosen.byCode) : valueOf(code),
            amount: Number(chosen.byCode),
          }
        : { code: typed, applicable: false, kind: null, value: 0, amount: 0 };
  return { ...cart, discount, automaticDiscounts, totalDiscount: Number(chosen.items) };
}

/** The percentage off, such as 12.5, or the amount off in paisa; 0 for free delivery. */
function valueOf(discount: Pick<DiscountCodeRecord, 'kind' | 'percentageBps' | 'amount'>): number {
  if (discount.kind === 'percentage') return (discount.percentageBps ?? 0) / 100;
  return Number(discount.amount ?? 0n);
}

/** What a cart keeps, as read. */
const KEPT = {
  id: carts.id,
  lines: carts.lines,
  note: carts.note,
  attributes: carts.attributes,
  discountCodes: carts.discountCodes,
};

/** The digest to find a cart by; null for anything that cannot be a cart's secret. */
function hashOf(token: string): Buffer | null {
  return TOKEN.test(token) ? sha256(token) : null;
}

function isEmpty(cart: CartContent): boolean {
  return cart.lines.length === 0 && cart.note === '' && Object.keys(cart.attributes).length === 0;
}
