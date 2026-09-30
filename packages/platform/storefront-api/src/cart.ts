// Carts, as storefronts and the core speak of them (ADR-042): the core keeps each shopper's cart,
// and the storefront changes it for them, as Shopify's cart forms and Ajax cart do, over HTTP with
// the platform's storefront key. Prices are in minor units (paisa), as in storefront documents;
// IDs are the documents' own.

/** Every storefront route of the core starts here, and needs the storefront key. */
export const STOREFRONT_API_PREFIX = '/storefront/';

/** Carries the secret from the shopper's cart cookie, which names their cart. */
export const CART_TOKEN_HEADER = 'x-hatti-cart';

/** What a storefront can do to a cart: Shopify's `/cart/add`, `/cart/change`, and so on. */
export type CartActionName = 'add' | 'change' | 'update' | 'clear';

export const CART_ACTIONS: readonly CartActionName[] = ['add', 'change', 'update', 'clear'];

/** A shop's cart: GET reads it, POST to `…/cart/{action}` changes it. */
export function cartPath(shopId: string, action?: CartActionName): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/cart${action ? `/${action}` : ''}`;
}

/** A line of the cart: by its key, by its variant (the first line with it), or by place, from 1. */
export type LineRef = { key: string } | { variantId: string } | { index: number };

export interface CartItemInput {
  variantId: string;
  /** 1 unless given. */
  quantity?: number;
  /** What the shopper gave for this line, such as a name to embroider; a name starting `_` is hidden. */
  properties?: Record<string, string>;
}

/** Adds each item to the line with its variant and properties, or as a new line, first. */
export interface CartAddBody {
  items: CartItemInput[];
}

/** Sets a line's quantity, 0 taking it out, or its properties. */
export interface CartChangeBody {
  line: LineRef;
  quantity?: number;
  properties?: Record<string, string>;
}

/**
 * Sets lines' quantities, a variant the cart lacks being added; the note; and attributes, an
 * empty value taking one away.
 */
export interface CartUpdateBody {
  updates?: { line: LineRef; quantity: number }[];
  note?: string;
  attributes?: Record<string, string>;
}

/** Takes every line out; the note and attributes stay. */
export type CartClearBody = Record<string, never>;

export interface CartBodies {
  add: CartAddBody;
  change: CartChangeBody;
  update: CartUpdateBody;
  clear: CartClearBody;
}

/** A line of the cart, priced as the catalog prices its variant now. */
export interface CartLineJson {
  /** The line's variant and properties: a line is added to when both match. */
  key: string;
  variantId: string;
  productId: string;
  quantity: number;
  properties: Record<string, string>;
  /** Each, and for the line. */
  price: number;
  linePrice: number;
  /** The product's title, and the variant's, such as "Red / M" or "Default Title". */
  title: string;
  variantTitle: string;
  sku: string | null;
  /** Each; 0 when not known. */
  grams: number;
  /**
   * The most the line can have now, when that is fewer than its quantity, as when stock ran out
   * after it was added; null while all of it can be bought.
   */
  maxQuantity: number | null;
}

export interface CartJson {
  note: string;
  attributes: Record<string, string>;
  /** The newest line first. Lines whose product is gone or no longer for sale are left out. */
  items: CartLineJson[];
  itemCount: number;
  subtotal: number;
  totalWeightGrams: number;
}

/** GET: the cart, or null when the token names none, as after it expired. */
export interface CartReadResponse {
  cart: CartJson | null;
}

/**
 * POST: the cart after the action, with its token, the one sent or a new cart's; null while
 * there is no cart, as after clearing none. `added` has the keys of the lines an `add` added to,
 * in its items' order.
 */
export interface CartChangeResponse {
  cart: CartJson;
  token: string | null;
  added: string[];
}

/** Why an action was refused (422); the cart is as it was. */
export type CartError =
  /** The request is not one the storefront should have sent. */
  | { code: 'INVALID'; message: string }
  /** No variant of the shop's with this ID is for sale. */
  | { code: 'NOT_FOUND'; variantId: string }
  /** The cart has no such line. */
  | { code: 'LINE_NOT_FOUND' }
  /**
   * More than can be bought: at most `max` of the variant across its lines, 0 when it is sold out,
   * or on one line, as many as an order's line takes.
   */
  | { code: 'MAX_QUANTITY'; variantId: string; title: string; max: number }
  /** A cart has at most `max` lines. */
  | { code: 'MAX_LINES'; max: number };

export interface CartErrorResponse {
  error: CartError;
}
