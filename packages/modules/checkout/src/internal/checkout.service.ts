import { createHash } from 'node:crypto';
import { InputChecker, StorefrontSite, shopProfile, type FieldError } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import type { CurrencyCode } from '@hatti/money';
import {
  shopAccentOf,
  shopPolicyVersionsOf,
  type PolicyVersionRef,
} from '@hatti/online-store/public';
import {
  ORDER_LIMITS,
  OrderService,
  checkAddress,
  codLimitError,
  type OrderRecord,
} from '@hatti/orders/public';
import {
  applyDiscountIn,
  discountCodeIn,
  discountFor,
  redeemDiscountIn,
  type DiscountCodeRecord,
  type DiscountRefusal,
} from '@hatti/pricing/public';
import type { CartJson } from '@hatti/storefront-api';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { CartService } from './cart.service.js';
import type { DeliverySettingsRecord } from './delivery.js';
import { DeliveryService } from './delivery.service.js';
import { checkouts } from './schema.js';
import { checkoutTotals } from './totals.js';

/** Where checkouts' pages are on the core's address: /checkouts/<secret>, as `checkoutPagePath`. */
export const CHECKOUT_PATH = 'checkouts';

/** How long a checkout lasts from when the shopper starts it, its thank-you page with it. */
export const CHECKOUT_HOURS = 24;

/** 128 random bits in base64url, as carts' and links' secrets. */
const TOKEN_BYTES = 16;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** Expired checkouts deleted each time a shop gets a new one. */
const SWEEP = 100;

/**
 * Codes a checkout's page takes that take nothing off before it takes no more, so that codes
 * cannot be guessed.
 */
export const DISCOUNT_ATTEMPTS = 10;

/** What the shopper typed on the page, every field as posted. */
export interface CheckoutForm {
  name: string;
  /** Their mobile number, which the courier and the shop call. */
  phone: string;
  city: string;
  /** The house and street. */
  address1: string;
  /** The area: "Gulshan-e-Iqbal". */
  address2: string;
  /** A place near it the rider can ask for: "near Jamia Masjid". */
  landmark: string;
  /** A province's code, or blank to take it from the city. */
  province: string;
}

export const EMPTY_FORM: CheckoutForm = {
  name: '',
  phone: '',
  city: '',
  address1: '',
  address2: '',
  landmark: '',
  province: '',
};

/** Why the order was not placed: the page shows the checkout again, with what the shopper typed. */
export type CheckoutProblem =
  /** The cart, or what delivery costs, changed after the page showed it. */
  | { kind: 'changed' }
  /** The address or number does not check out. */
  | { kind: 'address'; errors: FieldError[] }
  /** Some of the cart cannot be bought now, as when it sold out. */
  | { kind: 'unavailable' }
  /** It would collect more cash on delivery than the law allows an order (TAX-07). */
  | { kind: 'cod_limit' }
  /**
   * A discount code took nothing off: as it was typed or kept, and why; or the page has been
   * given too many that took nothing off.
   */
  | { kind: 'discount'; code: string; refusal: DiscountRefusal | { reason: 'attempts' } }
  /** The shop cannot take the order now, as when it has nowhere to send it from. */
  | { kind: 'refused' };

export interface CheckoutShop {
  name: string;
  /** Its storefront's address, to go back to. */
  storefront: string;
  /**
   * The policies it has, in Shopify's order, by kind and current version: the page links them as
   * Shopify's checkout does, and placing the order agrees to them (ADR-057).
   */
  policies: readonly PolicyVersionRef[];
  /**
   * Its theme's accent colour, such as "#B45309", for the page's buttons and links (CHK-14); null
   * when the theme leaves it to the platform's.
   */
  accent: string | null;
}

/** The discount code the shopper applied: what it is now, or why it takes nothing off now. */
export type CheckoutDiscount =
  | { code: string; record: DiscountCodeRecord; refusal: null }
  | { code: string; record: null; refusal: DiscountRefusal };

/** Where the shopper placed the order from, as their browser told the storefront. */
export interface CheckoutClient {
  ip: string | null;
  userAgent: string | null;
}

export type CheckoutView =
  | { kind: 'not_found' }
  | { kind: 'expired'; shop: CheckoutShop }
  /** Its cart is empty, or gone. */
  | { kind: 'empty'; shop: CheckoutShop }
  | {
      kind: 'open';
      shop: CheckoutShop;
      cartId: string;
      cart: CartJson;
      delivery: DeliverySettingsRecord;
      /** The code the shopper applied, if any. */
      discount: CheckoutDiscount | null;
      /** The digest of what the page shows, which its form carries. */
      shown: string;
      form: CheckoutForm;
      problem: CheckoutProblem | null;
    }
  | { kind: 'placed'; shop: CheckoutShop; order: OrderRecord };

/**
 * Checkouts (ADR-044): a shopper's cart becomes a cash-on-delivery order on a page of the core's,
 * at an address carrying a secret of its own. Nothing the shopper types is kept until the order
 * has it.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly carts: CartService,
    private readonly delivery: DeliveryService,
    private readonly orders: OrderService,
    private readonly storefronts: StorefrontSite,
  ) {}

  /**
   * Starts a checkout for the cart `cartToken` names: the secret its page's address carries; null
   * when the cart is gone, or holds nothing that can be bought.
   */
  async start(shopId: string, cartToken: string): Promise<string | null> {
    return this.db.tenant(shopId, async (tx) => {
      const cart = await this.carts.findIn(tx, shopId, cartToken);
      if (!cart || (await this.carts.priceIn(tx, shopId, cart)).items.length === 0) return null;
      await tx.execute(sql`
        DELETE FROM checkout.checkouts
         WHERE shop_id = ${shopId}
           AND id IN (SELECT id FROM checkout.checkouts
                       WHERE shop_id = ${shopId} AND expires_at < now()
                       LIMIT ${SWEEP})`);
      const secret = secretToken('', TOKEN_BYTES);
      await tx.insert(checkouts).values({
        shopId,
        id: newId(),
        tokenHash: sha256(secret),
        cartId: cart.id,
        expiresAt: sql`now() + ${`${CHECKOUT_HOURS} hours`}::interval`,
      });
      return secret;
    });
  }

  /** What the checkout's page shows; with `shopId`, only for that shop's checkouts. */
  async view(token: string, shopId?: string): Promise<CheckoutView> {
    const found = await this.#resolve(token, shopId);
    if (!found) return { kind: 'not_found' };
    return this.db.tenant(found.shopId, (tx) => this.#view(tx, found, false, EMPTY_FORM));
  }

  /**
   * Places the order as the page showed it (`shown`), to the address and number the shopper typed:
   * cash on delivery, with the shop's delivery charge for their city, its stock committed and its
   * risk scored as for any order, and what the shopper agreed to kept with it: the versions of the
   * shop's policies the page linked, and where `client` placed it from (ADR-057). A discount code
   * the shopper applied goes with it, and its use is counted with the order: a code used up since,
   * or used before by a customer meant to use it once, places nothing (ADR-063). Then the cart is
   * emptied. Placing twice places one order; what stops it shows the page again, saying why. With
   * `shopId`, only for that shop's checkouts.
   */
  async place(
    token: string,
    shown: string,
    form: CheckoutForm,
    options: { shopId?: string; client?: CheckoutClient } = {},
  ): Promise<CheckoutView> {
    const { shopId, client } = options;
    const found = await this.#resolve(token, shopId);
    if (!found) return { kind: 'not_found' };
    try {
      return await this.#place(found, shown, form, client);
    } catch (error) {
      if (!(error instanceof DiscountRefused)) throw error;
      // The order is undone; the page says why, with what the shopper typed.
      return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
        const view = await this.#view(tx, found, false, form);
        if (view.kind !== 'open') return view;
        return { ...view, problem: { kind: 'discount', code: error.code, refusal: error.refusal } };
      });
    }
  }

  async #place(
    found: { shopId: string; checkoutId: string },
    shown: string,
    form: CheckoutForm,
    client: CheckoutClient | undefined,
  ): Promise<CheckoutView> {
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
      const view = await this.#view(tx, found, true, form);
      if (view.kind !== 'open' || view.problem) return view;
      if (view.shown !== shown) return { ...view, problem: { kind: 'changed' } };
      const check = new InputChecker();
      const address = checkAddress(check, [], { ...form, zip: null });
      if (!address) return { ...view, problem: { kind: 'address', errors: check.errors } };
      if (view.cart.items.some((item) => item.maxQuantity !== null)) {
        return { ...view, problem: { kind: 'unavailable' } };
      }
      const profile = await shopProfile(tx, found.shopId);
      const code = view.discount?.record ?? null;
      const totals = checkoutTotals(BigInt(view.cart.subtotal), view.delivery, address.city, code);
      // Known once the city is.
      const delivery = totals.delivery!;
      const placed = await this.orders.placeIn(
        tx,
        {
          shopId: found.shopId,
          currency: profile.currency as CurrencyCode,
          actor: 'system',
          source: 'online_store',
          how: 'from the online store',
        },
        {
          field: [],
          // At the prices the page showed, which its digest says are the catalog's now.
          lines: view.cart.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            price: BigInt(item.price),
          })),
          address,
          email: null,
          paymentMethod: 'cash_on_delivery',
          shipping: totals.freeDelivery ? 0n : delivery,
          discount: totals.discount,
          discountCodes: code ? [code.code] : [],
          advance: 0n,
          locationId: null,
          note: orderNoteOf(view.cart),
          tags: [],
          agreement: {
            policyVersions: view.shop.policies.map((policy) => policy.versionId),
            ip: client?.ip ?? null,
            userAgent: client?.userAgent ?? null,
          },
        },
      );
      if (!placed.ok) {
        const codes = new Set(placed.errors.map((error) => error.code));
        const problem = codes.has('COD_LIMIT')
          ? 'cod_limit'
          : codes.has('OUT_OF_STOCK') || codes.has('NOT_FOUND')
            ? 'unavailable'
            : 'refused';
        return { ...view, problem: { kind: problem } };
      }
      if (code) {
        const redeemed = await redeemDiscountIn(tx, found.shopId, {
          codeId: code.id,
          orderId: placed.value.id,
          customerId: placed.value.customerId,
          amount: totals.discount + (totals.freeDelivery ? delivery : 0n),
        });
        if (!redeemed.ok) throw new DiscountRefused(code.code, redeemed.refusal);
      }
      await tx
        .update(checkouts)
        .set({ orderId: placed.value.id, completedAt: sql`now()` })
        .where(and(eq(checkouts.shopId, found.shopId), eq(checkouts.id, found.checkoutId)));
      await this.carts.emptyIn(tx, found.shopId, view.cartId);
      return { kind: 'placed', shop: view.shop, order: placed.value };
    });
  }

  async #view(
    tx: Tx,
    found: { shopId: string; checkoutId: string },
    lock: boolean,
    form: CheckoutForm,
  ): Promise<CheckoutView> {
    const { shopId, checkoutId } = found;
    const query = tx
      .select()
      .from(checkouts)
      .where(and(eq(checkouts.shopId, shopId), eq(checkouts.id, checkoutId)));
    const [checkout] = lock ? await query.for('update') : await query;
    if (!checkout) return { kind: 'not_found' };
    const profile = await shopProfile(tx, shopId);
    const shop = {
      name: profile.name,
      storefront: this.storefronts.url(profile.handle),
      policies: await shopPolicyVersionsOf(tx, shopId),
      accent: await shopAccentOf(tx, shopId),
    };
    // An expired checkout shows nothing, its thank-you page's address included.
    if (checkout.expiresAt <= new Date()) return { kind: 'expired', shop };
    if (checkout.orderId) {
      const order = await this.orders.orderOf(tx, shopId, checkout.orderId);
      return order ? { kind: 'placed', shop, order } : { kind: 'not_found' };
    }
    const cart = checkout.cartId
      ? await this.carts.cartIn(tx, shopId, checkout.cartId, lock)
      : null;
    if (!cart) return { kind: 'empty', shop };
    const priced = await this.carts.priceIn(tx, shopId, cart);
    if (priced.items.length === 0) return { kind: 'empty', shop };
    const delivery = await this.delivery.settingsOf(tx, shopId);
    const [typed] = cart.discountCodes;
    const discount =
      typed === undefined ? null : await discountOn(tx, shopId, typed, BigInt(priced.subtotal));
    const totals = checkoutTotals(
      BigInt(priced.subtotal),
      delivery,
      null,
      discount?.record ?? null,
    );
    // Items that alone come to more than cash on delivery may collect cannot be ordered here.
    const overLimit = codLimitError([], {
      paymentMethod: 'cash_on_delivery',
      currency: profile.currency,
      total: totals.subtotal - totals.discount,
      advance: 0n,
    });
    return {
      kind: 'open',
      shop,
      cartId: cart.id,
      cart: priced,
      delivery,
      discount,
      shown: shownOf(priced, delivery, shop.policies, discount),
      form,
      problem: overLimit ? { kind: 'cod_limit' } : null,
    };
  }

  /**
   * Applies the code the shopper typed to the checkout's cart, if it takes something off the
   * items now (or delivery, once the city is known); otherwise says why, and counts the attempt:
   * past {@link DISCOUNT_ATTEMPTS}, the page takes no more codes. With `shopId`, only for that
   * shop's checkouts.
   */
  async applyDiscount(
    token: string,
    typed: string,
    options: { shopId?: string } = {},
  ): Promise<CheckoutView> {
    const found = await this.#resolve(token, options.shopId);
    if (!found) return { kind: 'not_found' };
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
      const view = await this.#view(tx, found, true, EMPTY_FORM);
      if (view.kind !== 'open') return view;
      const shown = typed.trim().slice(0, 64);
      const [checkout] = await tx
        .select({ attempts: checkouts.discountAttempts })
        .from(checkouts)
        .where(and(eq(checkouts.shopId, found.shopId), eq(checkouts.id, found.checkoutId)));
      if ((checkout?.attempts ?? 0) >= DISCOUNT_ATTEMPTS) {
        return {
          ...view,
          problem: { kind: 'discount', code: shown, refusal: { reason: 'attempts' } },
        };
      }
      const applied = await applyDiscountIn(tx, found.shopId, typed, {
        subtotal: BigInt(view.cart.subtotal),
        shipping: 0n,
      });
      if (!applied.ok) {
        await tx
          .update(checkouts)
          .set({ discountAttempts: sql`${checkouts.discountAttempts} + 1` })
          .where(and(eq(checkouts.shopId, found.shopId), eq(checkouts.id, found.checkoutId)));
        return { ...view, problem: { kind: 'discount', code: shown, refusal: applied.refusal } };
      }
      await this.carts.setDiscountCodesIn(tx, found.shopId, view.cartId, [applied.code.code]);
      return this.#view(tx, found, false, EMPTY_FORM);
    });
  }

  /** Takes the discount code off the checkout's cart. */
  async removeDiscount(token: string, options: { shopId?: string } = {}): Promise<CheckoutView> {
    const found = await this.#resolve(token, options.shopId);
    if (!found) return { kind: 'not_found' };
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
      const view = await this.#view(tx, found, true, EMPTY_FORM);
      if (view.kind !== 'open') return view;
      await this.carts.setDiscountCodesIn(tx, found.shopId, view.cartId, []);
      return this.#view(tx, found, false, EMPTY_FORM);
    });
  }

  /**
   * The shop and checkout a secret names, whatever the shop, since the core's page knows no shop;
   * a storefront's is for its own shop's.
   */
  async #resolve(
    token: string,
    shopId: string | undefined,
  ): Promise<{ shopId: string; checkoutId: string } | null> {
    if (!TOKEN.test(token)) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; checkout_id: string }>(
      sql`SELECT * FROM checkout.resolve_checkout(${sha256(token)})`,
    );
    const row = rows[0];
    if (!row || (shopId !== undefined && row.shop_id !== shopId)) return null;
    return { shopId: row.shop_id, checkoutId: row.checkout_id };
  }
}

/**
 * A digest of what the page shows: the cart's lines at their prices, its note, what delivery
 * costs, the versions of the policies it links, and the discount code, as it was when shown and
 * whether it took anything off. The order is placed only as the page showed it, and agrees only
 * to what it linked.
 */
export function shownOf(
  cart: CartJson,
  delivery: DeliverySettingsRecord,
  policies: readonly PolicyVersionRef[],
  discount: CheckoutDiscount | null = null,
): string {
  const facts = {
    items: cart.items.map((item) => [item.key, item.quantity, item.price]),
    note: cart.note,
    delivery: [
      delivery.charge.toString(),
      delivery.freeAbove?.toString() ?? null,
      delivery.zones.map((zone) => [zone.cities, zone.charge.toString()]),
    ],
    policies: policies.map((policy) => policy.versionId),
    discount: discount && [
      discount.code,
      discount.record ? [discount.record.id, discount.record.version] : discount.refusal.reason,
    ],
  };
  return createHash('sha256').update(JSON.stringify(facts)).digest('base64url').slice(0, 22);
}

/** A code a customer may not use, met as their order is placed: the order is undone. */
class DiscountRefused extends Error {
  constructor(
    readonly code: string,
    readonly refusal: DiscountRefusal,
  ) {
    super(`The discount code ${code} was refused: ${refusal.reason}`);
    this.name = 'DiscountRefused';
  }
}

/** The code `typed` a cart keeps, as it is now for items coming to `subtotal`. */
async function discountOn(
  tx: Tx,
  shopId: string,
  typed: string,
  subtotal: bigint,
): Promise<CheckoutDiscount> {
  const record = await discountCodeIn(tx, shopId, typed);
  if (!record) return { code: typed, record: null, refusal: { reason: 'unknown' } };
  const applied = discountFor(record, { subtotal, shipping: 0n });
  return applied.ok
    ? { code: record.code, record, refusal: null }
    : { code: record.code, record: null, refusal: applied.refusal };
}

/** "Peshawari Chappal (8)"; a product without options by its title alone. */
export function itemName(title: string, variantTitle: string): string {
  return variantTitle === DEFAULT_VARIANT_TITLE ? title : `${title} (${variantTitle})`;
}

/**
 * The properties of a line the shopper sees, such as an engraving's text. Those whose names start
 * with "_" are for apps, and hidden, as on Shopify.
 */
export function shownProperties(properties: Record<string, string>): [string, string][] {
  return Object.entries(properties).filter(([name]) => !name.startsWith('_'));
}

/**
 * The order's note: the cart's, then each line's properties, which orders keep no other way, cut
 * to what an order's note holds.
 */
export function orderNoteOf(cart: CartJson): string {
  const lines = cart.items.flatMap((item) => {
    const properties = shownProperties(item.properties);
    if (properties.length === 0) return [];
    const values = properties.map(([name, value]) => `${name}: ${value}`).join(', ');
    return [`${item.quantity} × ${itemName(item.title, item.variantTitle)}: ${values}`];
  });
  const note = [cart.note.trim(), ...lines].filter((part) => part !== '').join('\n');
  const max = ORDER_LIMITS.note;
  return note.length <= max ? note : `${note.slice(0, max - 1)}…`;
}
