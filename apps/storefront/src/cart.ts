import type {
  CartActionName,
  CartBodies,
  StorefrontApiClient,
  CartDiscountJson,
  CartError,
  CartItemInput,
  CartJson,
  CartLineJson,
  LineRef,
} from '@hatti/storefront-api';
import type { ProductDoc } from '@hatti/storefront-data';

// The storefront's side of carts (ADR-042): Shopify's cart forms and Ajax cart, turned into the
// core's actions, and the core's carts turned back into what themes and their scripts expect.

/** Where carts are kept: the core, through `StorefrontApiClient`, or anything answering as it does. */
export type CoreBackend = Pick<
  StorefrontApiClient,
  | 'read'
  | 'act'
  | 'startCheckout'
  | 'openPaymentLink'
  | 'checkoutPage'
  | 'search'
  | 'searchContent'
  | 'themePreview'
  | 'signUp'
  | 'postComment'
>;

/** The secret naming the shopper's cart, which scripts cannot read. */
export const CART_COOKIE = 'cart';
/** How many items the cart has, for scripts to show on pages cached for everyone. */
export const CART_COUNT_COOKIE = 'cart_count';
/** As long as a cart lasts after its last change. */
export const CART_COOKIE_SECONDS = 14 * 24 * 60 * 60;

/** A cart path, as Shopify has them: `/cart`, `/cart.js`, `/cart/add`, `/cart/change.js`… */
export interface CartRoute {
  /** `show` for `/cart` itself: read on GET, updated on POST. */
  action: CartActionName | 'show';
  /** `/cart.js` and the like answer JSON; so do requests from scripts. */
  json: boolean;
}

const CART_PATH = /^\/cart(?:\/(add|change|update|clear))?(\.js|\.json)?\/?$/;

/** The cart route a path names, without its language prefix; null for other paths. */
export function cartRoute(path: string): CartRoute | null {
  const match = CART_PATH.exec(path);
  if (!match) return null;
  return { action: (match[1] as CartActionName | undefined) ?? 'show', json: !!match[2] };
}

const PERMALINK = /^\/cart\/([^/]+?)\/?$/;
const PERMALINK_ITEM = /^([0-9A-Za-z-]{1,64}):(\d{1,6})$/;

/**
 * The items a cart permalink names, as Shopify's are written: `/cart/{variant}:{quantity}`, more
 * of them separated by commas, the path without its language prefix; null for other paths.
 */
export function permalinkItems(path: string): Required<CartItemInput>[] | null {
  const match = PERMALINK.exec(path);
  if (!match) return null;
  let listed: string;
  try {
    // Some apps write the colons and commas percent-encoded.
    listed = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const items: Required<CartItemInput>[] = [];
  for (const part of listed.split(',')) {
    const item = PERMALINK_ITEM.exec(part.trim());
    if (!item) return null;
    items.push({ variantId: item[1]!, quantity: Number(item[2]), properties: {} });
  }
  return items;
}

/**
 * Parameters as Rails and Shopify read them from a form: `items[][id]` and `items[0][id]` build
 * a list of items, `properties[Name]` an object, `updates[]` a list.
 */
export function parseForm(body: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [name, value] of new URLSearchParams(body)) {
    const path = keyPath(name);
    if (!path) continue;
    assign(root, path, value);
  }
  return root;
}

function keyPath(name: string): string[] | null {
  const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(name);
  if (!match) return null;
  const rest = [...match[2]!.matchAll(/\[([^[\]]*)\]/g)].map((part) => part[1]!);
  return [match[1]!, ...rest];
}

function assign(target: Record<string, unknown> | unknown[], path: string[], value: string): void {
  const [key, ...rest] = path;
  if (key === undefined || ['__proto__', 'constructor', 'prototype'].includes(key)) return;
  const isList = Array.isArray(target);
  if (rest.length === 0) {
    if (isList) target.push(value);
    else if (key !== '') target[key] = value;
    return;
  }
  const nextIsList = rest[0] === '';
  if (isList) {
    // `items[][id]`: a new item begins when the last one already has this field.
    const last = target.at(-1);
    const field = rest[0]!;
    if (key === '' && isRecord(last) && !Object.hasOwn(last, field)) {
      assign(last, rest, value);
      return;
    }
    const child: Record<string, unknown> | unknown[] = nextIsList ? [] : {};
    target.push(child);
    assign(child, rest, value);
    return;
  }
  if (key === '') return;
  let child = target[key];
  if (!isRecord(child) && !Array.isArray(child)) {
    child = nextIsList ? [] : {};
    target[key] = child;
  }
  assign(child as Record<string, unknown> | unknown[], rest, value);
}

/**
 * Shopify's parameters for `action`, from a form, a script's JSON or a link's query, as the
 * core takes them. `single` says an `add` named one item, not `items`, and so wants that line
 * back rather than a list. Values the storefront cannot make sense of go to the core as they
 * are, which refuses them.
 */
export function cartBody<A extends CartActionName>(
  action: A,
  params: Record<string, unknown>,
): { body: CartBodies[A]; single: boolean } {
  switch (action) {
    case 'add': {
      const listed = listOf(params.items);
      const items = (listed ?? [params]).map((item) => {
        const fields = isRecord(item) ? item : {};
        return {
          variantId: String(fields.id ?? ''),
          quantity: number(fields.quantity ?? 1) as number,
          properties: texts(fields.properties),
        };
      });
      return { body: { items } as CartBodies[A], single: listed === null };
    }
    case 'change': {
      const body: CartBodies['change'] = { line: lineOf(params) };
      if (params.quantity !== undefined) body.quantity = number(params.quantity) as number;
      if (params.properties !== undefined) body.properties = texts(params.properties);
      return { body: body as CartBodies[A], single: false };
    }
    case 'update': {
      const body: CartBodies['update'] = {};
      const updates = params.updates;
      if (Array.isArray(updates)) {
        body.updates = updates.map((quantity, index) => ({
          line: { index: index + 1 },
          quantity: number(quantity) as number,
        }));
      } else if (isRecord(updates)) {
        body.updates = Object.entries(updates).map(([id, quantity]) => ({
          line: idRef(id),
          quantity: number(quantity) as number,
        }));
      }
      if (params.note !== undefined) body.note = String(params.note);
      if (params.attributes !== undefined) body.attributes = texts(params.attributes);
      // Shopify's discount codes, separated by commas; an empty one takes the code off.
      if (params.discount !== undefined) body.discount = params.discount as string;
      return { body: body as CartBodies[A], single: false };
    }
    default:
      return { body: {} as CartBodies[A], single: false };
  }
}

/** `id` names a line by key (`variant:digest`) or by variant; `line`, by place from 1. */
function lineOf(params: Record<string, unknown>): LineRef {
  if (params.line !== undefined) return { index: number(params.line) as number };
  return idRef(String(params.id ?? ''));
}

function idRef(id: string): LineRef {
  return id.includes(':') ? { key: id } : { variantId: id };
}

/** A whole number from a form's text; anything else as it is, for the core to refuse. */
function number(value: unknown): unknown {
  return typeof value === 'string' && /^\s*-?\d{1,15}\s*$/.test(value) ? Number(value) : value;
}

/** Properties or attributes, their values as text; blank names are dropped. */
function texts(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const named: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (name === '') continue;
    if (typeof text === 'string' || typeof text === 'number' || typeof text === 'boolean') {
      named[name] = String(text);
    }
  }
  return named;
}

/** `items` as a list, from JSON's array or a form's `items[0]`, `items[1]`… */
function listOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The product documents of a cart's lines, by product ID; missing while being published. */
export async function cartProducts(
  cart: CartJson | null,
  products: (ids: readonly string[]) => Promise<(ProductDoc | null)[]>,
): Promise<Map<string, ProductDoc>> {
  const ids = [...new Set(cart?.items.map((item) => item.productId) ?? [])];
  const docs = ids.length > 0 ? await products(ids) : [];
  return new Map(docs.flatMap((doc) => (doc ? [[doc.id, doc] as const] : [])));
}

/**
 * A cart as Shopify's `/cart.js` gives it to scripts. Its discount code takes its part off the
 * whole cart, not off lines: `total_price` is what the items come to after it.
 */
export function ajaxCart(
  cart: CartJson | null,
  products: ReadonlyMap<string, ProductDoc>,
): Record<string, unknown> {
  const items = cart?.items ?? [];
  const subtotal = cart?.subtotal ?? 0;
  const discount = cart?.discount ?? null;
  return {
    note: cart?.note ?? '',
    attributes: cart?.attributes ?? {},
    original_total_price: subtotal,
    total_price: subtotal - (cart?.totalDiscount ?? 0),
    total_discount: cart?.totalDiscount ?? 0,
    total_weight: cart?.totalWeightGrams ?? 0,
    item_count: cart?.itemCount ?? 0,
    items: items.map((item) => ajaxLineItem(item, products.get(item.productId))),
    requires_shipping: items.length > 0,
    currency: 'PKR',
    items_subtotal_price: subtotal,
    cart_level_discount_applications: itemsDiscounted(discount)
      ? [
          {
            type: 'discount_code',
            title: discount.code,
            description: null,
            // As Shopify's scripts get it: "10.0" percent, or rupees.
            value: decimal(discount.kind === 'percentage' ? discount.value : discount.value / 100),
            value_type: discount.kind === 'percentage' ? 'percentage' : 'fixed_amount',
            allocation_method: 'across',
            target_selection: 'all',
            target_type: 'line_item',
            total_allocated_amount: discount.amount,
          },
        ]
      : [],
    discount_codes: discount ? [{ code: discount.code, applicable: discount.applicable }] : [],
  };
}

/**
 * Whether the cart's discount code takes something off its items now, a percentage or an
 * amount: a free-delivery code takes its part off at checkout.
 */
export function itemsDiscounted(
  discount: CartDiscountJson | null,
): discount is CartDiscountJson & { kind: 'percentage' | 'fixed_amount' } {
  return (
    discount !== null &&
    discount.applicable &&
    discount.kind !== 'free_shipping' &&
    discount.kind !== null &&
    discount.amount > 0
  );
}

/** A number as Shopify's Ajax API writes decimals: "10.0", "12.5". */
function decimal(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** A line as Shopify's Ajax cart gives it. */
export function ajaxLineItem(
  item: CartLineJson,
  product: ProductDoc | undefined,
): Record<string, unknown> {
  const variant = product?.variants.find((each) => each.id === item.variantId);
  const onlyDefault = !product || isOnlyDefault(product);
  const imageDoc =
    (variant?.image !== null && variant?.image !== undefined
      ? product?.images[variant.image]
      : undefined) ?? product?.images[0];
  return {
    id: item.variantId,
    variant_id: item.variantId,
    product_id: item.productId,
    key: item.key,
    quantity: item.quantity,
    properties: item.properties,
    title: lineTitle(item, onlyDefault),
    product_title: product?.title ?? item.title,
    variant_title: onlyDefault ? null : item.variantTitle,
    variant_options: variant?.options ?? [],
    options_with_values: (product?.options ?? []).map((option, index) => ({
      name: option.name,
      value: variant?.options[index] ?? '',
    })),
    price: item.price,
    original_price: item.price,
    discounted_price: item.price,
    final_price: item.price,
    line_price: item.linePrice,
    original_line_price: item.linePrice,
    final_line_price: item.linePrice,
    total_discount: 0,
    discounts: [],
    line_level_discount_allocations: [],
    line_level_total_discount: 0,
    sku: item.sku,
    grams: item.grams,
    vendor: product?.vendor ?? '',
    product_type: product?.productType ?? '',
    product_has_only_default_variant: onlyDefault,
    handle: product?.handle ?? null,
    url: product ? `/products/${product.handle}?variant=${item.variantId}` : null,
    image: imageDoc?.src ?? null,
    featured_image: imageDoc
      ? {
          url: imageDoc.src,
          alt: imageDoc.alt ?? product!.title,
          width: imageDoc.width,
          height: imageDoc.height,
          aspect_ratio:
            imageDoc.height > 0 ? Math.round((imageDoc.width / imageDoc.height) * 1000) / 1000 : 1,
        }
      : null,
    requires_shipping: true,
    gift_card: false,
    taxable: item.taxable,
    /** Hatti's: the most the line can have now, when fewer than its quantity. */
    max_quantity: item.maxQuantity,
  };
}

/** "Lawn 3-piece - M", or the product's title alone for a product without options. */
export function lineTitle(item: CartLineJson, onlyDefault: boolean): string {
  return onlyDefault ? item.title : `${item.title} - ${item.variantTitle}`;
}

export function isOnlyDefault(product: ProductDoc): boolean {
  return (
    product.options.length === 1 &&
    product.options[0]!.name === 'Title' &&
    product.options[0]!.values.length === 1
  );
}

/** The theme's words for why a cart change was refused, and the English they fall back to. */
export function cartErrorMessage(
  error: CartError,
  translate: (key: string, values: Record<string, unknown>) => string | null,
): string {
  const say = (key: string, values: Record<string, unknown>, english: string) =>
    translate(`cart.errors.${key}`, values) ?? english;
  switch (error.code) {
    case 'MAX_QUANTITY': {
      if (error.max === 0)
        return say('sold_out', { title: error.title }, `${error.title} is sold out.`);
      const max = error.max.toLocaleString('en');
      return say(
        'max_quantity',
        { title: error.title, max },
        `You can have at most ${max} of ${error.title} in your cart.`,
      );
    }
    case 'NOT_FOUND':
      return say('not_found', {}, 'This product is no longer for sale.');
    case 'LINE_NOT_FOUND':
      return say('changed', {}, 'Your cart has changed. Please check it again.');
    case 'MAX_LINES':
      return say(
        'max_lines',
        { max: error.max },
        `Your cart is full: it holds up to ${error.max} products.`,
      );
    case 'INVALID':
      return say('invalid', {}, 'That did not work. Please try again.');
    case 'EMPTY':
      return say('empty', {}, 'Your cart is empty.');
  }
}

/** The status Shopify's Ajax cart answers a refusal with. */
export function cartErrorStatus(error: CartError): number {
  return error.code === 'NOT_FOUND' ? 404 : 422;
}

/** A cookie of the request's, by name. */
export function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/**
 * The cookies that keep the shopper's cart: its secret, which only the server reads, and its
 * count, which pages' scripts show. A null token forgets both.
 */
export function cartCookies(
  token: string | null,
  itemCount: number,
  options: { secure: boolean },
): string[] {
  const common = cookieAttributes(options);
  if (token === null) {
    return [
      `${CART_COOKIE}=; Max-Age=0; ${common}; HttpOnly`,
      `${CART_COUNT_COOKIE}=; Max-Age=0; ${common}`,
    ];
  }
  return [
    `${CART_COOKIE}=${token}; Max-Age=${CART_COOKIE_SECONDS}; ${common}; HttpOnly`,
    cartCountCookie(itemCount, options),
  ];
}

/** The count cookie alone, as when an order placed from the cart emptied it. */
export function cartCountCookie(itemCount: number, options: { secure: boolean }): string {
  return `${CART_COUNT_COOKIE}=${itemCount}; Max-Age=${CART_COOKIE_SECONDS}; ${cookieAttributes(options)}`;
}

function cookieAttributes(options: { secure: boolean }): string {
  return `Path=/; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}
