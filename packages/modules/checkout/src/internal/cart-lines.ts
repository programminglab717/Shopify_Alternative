import { createHash } from 'node:crypto';
import { typedCode } from '@hatti/pricing/public';
import type {
  CartActionName,
  CartError,
  CartJson,
  CartLineJson,
  LineRef,
} from '@hatti/storefront-api';

/** What a cart can hold. Lines, and units on a line, are as many as an order takes. */
export const CART_LIMITS = {
  lines: 100,
  quantity: 10_000,
  /** A line's properties, and a cart's attributes. */
  properties: 25,
  attributes: 25,
  /** Characters in a property's or attribute's name, and in its value. */
  name: 100,
  value: 1_000,
  note: 5_000,
} as const;

/** How long a cart lasts after its last change, in days: as long as Shopify's cart cookie. */
export const CART_DAYS = 14;

/** A line as a cart keeps it: without a price, which is read whenever the cart is. */
export interface StoredLine {
  variantId: string;
  quantity: number;
  properties: Record<string, string>;
}

/** What a cart holds. */
export interface CartContent {
  /** The newest first. */
  lines: StoredLine[];
  note: string;
  attributes: Record<string, string>;
}

export const EMPTY_CART: CartContent = { lines: [], note: '', attributes: {} };

/** A variant as the catalog and inventory have it now. */
export interface VariantFacts {
  productId: string;
  /** The product's, and the variant's. */
  title: string;
  variantTitle: string;
  sku: string | null;
  /** Minor units, each. */
  price: bigint;
  /** Each; 0 when not known. */
  grams: number;
  /** Whether its price includes the shop's sales tax (ADR-096). */
  taxable: boolean;
  /** Its product is active, so it can be sold. */
  forSale: boolean;
  /** How many can be sold online now; null for no limit. */
  sellable: number | null;
}

/** What a storefront asked of a cart, checked. */
export type CartAction =
  | { kind: 'add'; items: StoredLine[] }
  | {
      kind: 'change';
      line: LineRef;
      quantity: number | null;
      properties: Record<string, string> | null;
    }
  | {
      kind: 'update';
      updates: { line: LineRef; quantity: number }[];
      note: string | null;
      /** An empty value takes the attribute away. */
      attributes: Record<string, string> | null;
      /** The discount code to keep, none taking it off; null leaves it as it is. */
      discountCodes: string[] | null;
    }
  | { kind: 'clear' };

/** A cart after an action, and the keys of the lines an `add` added to. */
export interface Applied extends CartContent {
  added: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `id` could be a variant's: the storefront's documents name them by UUID. */
export function isVariantId(id: string): boolean {
  return UUID.test(id);
}

/**
 * A line's key, `{variant}:{digest of its properties}`, as Shopify keys lines: adding the same
 * variant with the same properties adds to that line.
 */
export function lineKey(line: Pick<StoredLine, 'variantId' | 'properties'>): string {
  const entries = Object.entries(line.properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return `${line.variantId}:${digest.slice(0, 32)}`;
}

/** The variants an action names, whose facts it needs besides those of the cart's lines. */
export function variantsNamed(action: CartAction): string[] {
  switch (action.kind) {
    case 'add':
      return action.items.map((item) => item.variantId);
    case 'update':
      return action.updates.flatMap(({ line }) =>
        'variantId' in line && isVariantId(line.variantId) ? [line.variantId] : [],
      );
    default:
      return [];
  }
}

/**
 * Checks what a storefront sent for `name`. The storefront makes these bodies from Shopify's
 * forms and Ajax calls, so anything else is refused as INVALID; a variant ID that is not one is
 * NOT_FOUND, as Shopify answers.
 */
export function parseAction(name: CartActionName, body: unknown): CartAction | CartError {
  if (!isRecord(body)) return invalid('The body must be a JSON object');
  switch (name) {
    case 'add': {
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return invalid('items must list what to add');
      }
      if (body.items.length > CART_LIMITS.lines) {
        return { code: 'MAX_LINES', max: CART_LIMITS.lines };
      }
      const items: StoredLine[] = [];
      for (const item of body.items) {
        if (!isRecord(item) || typeof item.variantId !== 'string') {
          return invalid('Each item needs a variantId');
        }
        if (!isVariantId(item.variantId)) return { code: 'NOT_FOUND', variantId: item.variantId };
        const quantity = quantityOf(item.quantity ?? 1, 1);
        if (typeof quantity === 'string') return invalid(quantity);
        const properties = namedValues(item.properties ?? {}, 'property', CART_LIMITS.properties);
        if (typeof properties === 'string') return invalid(properties);
        items.push({ variantId: item.variantId, quantity, properties: withoutBlanks(properties) });
      }
      return { kind: 'add', items };
    }
    case 'change': {
      const line = lineRefOf(body.line);
      if (typeof line === 'string') return invalid(line);
      const quantity = body.quantity === undefined ? null : quantityOf(body.quantity, 0);
      if (typeof quantity === 'string') return invalid(quantity);
      const properties =
        body.properties === undefined
          ? null
          : namedValues(body.properties, 'property', CART_LIMITS.properties);
      if (typeof properties === 'string') return invalid(properties);
      return {
        kind: 'change',
        line,
        quantity,
        properties: properties && withoutBlanks(properties),
      };
    }
    case 'update': {
      const updates: { line: LineRef; quantity: number }[] = [];
      if (body.updates !== undefined) {
        if (!Array.isArray(body.updates) || body.updates.length > CART_LIMITS.lines) {
          return invalid(`updates must list at most ${CART_LIMITS.lines} lines`);
        }
        for (const update of body.updates) {
          if (!isRecord(update)) return invalid('Each update needs a line and a quantity');
          const line = lineRefOf(update.line);
          if (typeof line === 'string') return invalid(line);
          const quantity = quantityOf(update.quantity, 0);
          if (typeof quantity === 'string') return invalid(quantity);
          updates.push({ line, quantity });
        }
      }
      let note: string | null = null;
      if (body.note !== undefined) {
        if (typeof body.note !== 'string') return invalid('note must be text');
        if (body.note.length > CART_LIMITS.note) {
          return invalid(`A note has at most ${CART_LIMITS.note} characters`);
        }
        note = body.note;
      }
      const attributes =
        body.attributes === undefined
          ? null
          : namedValues(body.attributes, 'attribute', CART_LIMITS.attributes);
      if (typeof attributes === 'string') return invalid(attributes);
      let discountCodes: string[] | null = null;
      if (body.discount !== undefined) {
        if (typeof body.discount !== 'string' || body.discount.length > CART_LIMITS.note) {
          return invalid('discount must be text: codes separated by commas');
        }
        discountCodes = discountCodesOf(body.discount);
      }
      return { kind: 'update', updates, note, attributes, discountCodes };
    }
    case 'clear':
      return { kind: 'clear' };
  }
}

/**
 * The code a cart keeps from Shopify's `discount`, codes separated by commas: the first a shop
 * could have, as typed. One for now, as codes do not combine yet.
 */
export function discountCodesOf(text: string): string[] {
  for (const part of text.split(',')) {
    const code = typedCode(part);
    if (code !== null) return [code];
  }
  return [];
}

/**
 * Does `action` to `cart`, as Shopify's cart does, with what the catalog and inventory say now.
 * Lines whose product is gone or no longer for sale leave with the change. Refused when the cart
 * would have more of a variant than can be sold (only for variants it gains units of: lines whose
 * stock ran out stay for checkout to deal with), more on a line than an order takes, or more
 * lines.
 */
export function applyAction(
  cart: CartContent,
  action: CartAction,
  facts: ReadonlyMap<string, VariantFacts>,
): Applied | CartError {
  const before = cart.lines.filter((line) => facts.get(line.variantId)?.forSale);
  let lines = before.map((line) => ({ ...line }));
  let { note, attributes } = cart;
  const added: string[] = [];

  switch (action.kind) {
    case 'add': {
      const fresh: StoredLine[] = [];
      for (const item of action.items) {
        if (!facts.get(item.variantId)?.forSale) {
          return { code: 'NOT_FOUND', variantId: item.variantId };
        }
        const key = lineKey(item);
        const line = [...fresh, ...lines].find((other) => lineKey(other) === key);
        if (line) line.quantity += item.quantity;
        else fresh.push({ ...item });
        if (!added.includes(key)) added.push(key);
      }
      lines = [...fresh, ...lines];
      break;
    }
    case 'change': {
      const at = findLine(lines, action.line);
      if (at < 0) return { code: 'LINE_NOT_FOUND' };
      const line = lines[at]!;
      if (action.quantity !== null) line.quantity = action.quantity;
      if (action.properties !== null) {
        line.properties = action.properties;
        // Now the same as another line: the two become one.
        const key = lineKey(line);
        const twin = lines.findIndex((other, index) => index !== at && lineKey(other) === key);
        if (twin >= 0) {
          lines[twin]!.quantity += line.quantity;
          lines.splice(at, 1);
        }
      }
      lines = lines.filter((other) => other.quantity > 0);
      break;
    }
    case 'update': {
      // Each update names a line as the cart was before any of them.
      const fresh: StoredLine[] = [];
      for (const { line: ref, quantity } of action.updates) {
        const at = findLine(before, ref);
        if (at >= 0) {
          lines[at]!.quantity = quantity;
          continue;
        }
        if (!('variantId' in ref)) return { code: 'LINE_NOT_FOUND' };
        if (!facts.get(ref.variantId)?.forSale) {
          return { code: 'NOT_FOUND', variantId: ref.variantId };
        }
        const line = fresh.find((other) => other.variantId === ref.variantId);
        if (line) line.quantity = quantity;
        else fresh.push({ variantId: ref.variantId, quantity, properties: {} });
      }
      lines = [...fresh, ...lines].filter((line) => line.quantity > 0);
      if (action.note !== null) note = action.note;
      if (action.attributes !== null) {
        attributes = { ...attributes };
        for (const [name, value] of Object.entries(action.attributes)) {
          if (value === '') delete attributes[name];
          else attributes[name] = value;
        }
        if (Object.keys(attributes).length > CART_LIMITS.attributes) {
          return invalid(`A cart has at most ${CART_LIMITS.attributes} attributes`);
        }
      }
      break;
    }
    case 'clear':
      lines = [];
      break;
  }

  if (lines.length > CART_LIMITS.lines) return { code: 'MAX_LINES', max: CART_LIMITS.lines };
  for (const line of lines) {
    if (line.quantity > CART_LIMITS.quantity) {
      const { title } = facts.get(line.variantId)!;
      return { code: 'MAX_QUANTITY', variantId: line.variantId, title, max: CART_LIMITS.quantity };
    }
  }
  const had = totals(before);
  for (const [variantId, quantity] of totals(lines)) {
    if (quantity <= (had.get(variantId) ?? 0)) continue;
    const { sellable, title } = facts.get(variantId)!;
    if (sellable !== null && quantity > sellable) {
      return { code: 'MAX_QUANTITY', variantId, title, max: sellable };
    }
  }
  return { lines, note, attributes, added };
}

/**
 * The cart as a storefront shows it, priced now. Lines whose product is gone or no longer for
 * sale are left out.
 */
export function cartJson(cart: CartContent, facts: ReadonlyMap<string, VariantFacts>): CartJson {
  const lines = cart.lines.filter((line) => facts.get(line.variantId)?.forSale);
  const inCart = totals(lines);
  const items = lines.map((line): CartLineJson => {
    const variant = facts.get(line.variantId)!;
    const all = inCart.get(line.variantId)!;
    const short = variant.sellable !== null && all > variant.sellable;
    return {
      key: lineKey(line),
      variantId: line.variantId,
      productId: variant.productId,
      quantity: line.quantity,
      properties: line.properties,
      price: Number(variant.price),
      linePrice: Number(variant.price * BigInt(line.quantity)),
      title: variant.title,
      variantTitle: variant.variantTitle,
      sku: variant.sku,
      grams: variant.grams,
      taxable: variant.taxable,
      maxQuantity: short ? Math.max(0, variant.sellable! - (all - line.quantity)) : null,
    };
  });
  return {
    note: cart.note,
    attributes: cart.attributes,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: items.reduce((sum, item) => sum + item.linePrice, 0),
    totalWeightGrams: items.reduce((sum, item) => sum + item.grams * item.quantity, 0),
    // What a discount code takes off is the cart service's to add: it reads the code.
    discount: null,
    totalDiscount: 0,
  };
}

function findLine(lines: readonly StoredLine[], ref: LineRef): number {
  if ('index' in ref) return ref.index <= lines.length ? ref.index - 1 : -1;
  if ('key' in ref) return lines.findIndex((line) => lineKey(line) === ref.key);
  return lines.findIndex((line) => line.variantId === ref.variantId);
}

/** Units of each variant, across its lines. */
function totals(lines: readonly StoredLine[]): Map<string, number> {
  const units = new Map<string, number>();
  for (const line of lines) {
    units.set(line.variantId, (units.get(line.variantId) ?? 0) + line.quantity);
  }
  return units;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): CartError {
  return { code: 'INVALID', message };
}

/** A whole number of units from `min`; above a line's limit is for the cart to refuse. */
function quantityOf(value: unknown, min: number): number | string {
  return Number.isSafeInteger(value) && (value as number) >= min
    ? (value as number)
    : `quantity must be a whole number from ${min}`;
}

function lineRefOf(value: unknown): LineRef | string {
  if (isRecord(value)) {
    if (typeof value.key === 'string') return { key: value.key };
    if (typeof value.variantId === 'string') return { variantId: value.variantId };
    if (Number.isSafeInteger(value.index) && (value.index as number) >= 1) {
      return { index: value.index as number };
    }
  }
  return 'line must name a line by its key, its variantId, or its index from 1';
}

/** A line's properties or a cart's attributes: text by name, within their limits. */
function namedValues(
  value: unknown,
  what: 'property' | 'attribute',
  max: number,
): Record<string, string> | string {
  if (!isRecord(value))
    return `${what === 'property' ? 'properties' : 'attributes'} must be an object`;
  const entries = Object.entries(value);
  if (entries.length > max)
    return `At most ${max} ${what === 'property' ? 'properties' : 'attributes'}`;
  const named: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (name.trim() === '' || name.length > CART_LIMITS.name) {
      return `A ${what}'s name has 1 to ${CART_LIMITS.name} characters`;
    }
    if (typeof text !== 'string') return `The ${what} "${name}" must be text`;
    if (text.length > CART_LIMITS.value) {
      return `The ${what} "${name}" has at most ${CART_LIMITS.value} characters`;
    }
    named[name] = text;
  }
  return named;
}

/** Properties left blank are not the line's, as in Shopify. */
function withoutBlanks(properties: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value.trim() !== ''));
}
