import { createHash } from 'node:crypto';
import type { CartActionResult, CartError, CartJson, CartLineJson } from '@hatti/storefront-api';
import type {
  CollectionDoc,
  ImageDoc,
  ProductDoc,
  ShopDoc,
  StoreData,
  VariantDoc,
} from '@hatti/storefront-data';
import {
  GraphQLError,
  Kind,
  buildSchema,
  execute,
  parse,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type SelectionSetNode,
} from 'graphql';
import { imageAddress, unescapeHtml } from './liquid.js';

// The Storefront API (DEV-02, ADR-848): GraphQL for headless storefronts and shopping apps, at
// the shop's own address, /api/<version>/graphql.json, as Shopify's, with a token of the shop's,
// public or private. It reads the shop's catalog from its storefront documents, as its pages do,
// and changes carts through the core, as its cart does; a cart's checkoutUrl is the shop's own
// checkout. A subset of Shopify's schema, its names and shapes kept, so its clients ask it alike.

export const STOREFRONT_API_LIMITS = {
  /** The longest query read, and how deep it may ask. */
  query: 20_000,
  depth: 12,
  /** The most of a list one field gives. */
  first: 250,
  /** Lines a mutation adds or changes at once. */
  lines: 100,
} as const;

/** The headers a token comes in, as Shopify's: a public one, and a private one. */
export const STOREFRONT_TOKEN_HEADERS = {
  public: 'x-shopify-storefront-access-token',
  private: 'shopify-storefront-private-token',
} as const;

const SDL = /* GraphQL */ `
  """
  A shop's Storefront API (ADR-848): its catalog as its pages show it, and carts its checkout takes.
  """
  type Query {
    shop: Shop!
    product(id: ID, handle: String): Product
    """
    The shop's products: those a search finds, the likeliest first, where query is given.
    """
    products(first: Int, after: String, query: String): ProductConnection!
    collection(id: ID, handle: String): Collection
    collections(first: Int, after: String): CollectionConnection!
    cart(id: ID!): Cart
  }

  type Mutation {
    cartCreate(input: CartInput): CartCreatePayload
    cartLinesAdd(cartId: ID!, lines: [CartLineInput!]!): CartLinesAddPayload
    cartLinesUpdate(cartId: ID!, lines: [CartLineUpdateInput!]!): CartLinesUpdatePayload
    cartLinesRemove(cartId: ID!, lineIds: [ID!]!): CartLinesRemovePayload
    cartNoteUpdate(cartId: ID!, note: String!): CartNoteUpdatePayload
    cartDiscountCodesUpdate(cartId: ID!, discountCodes: [String!]): CartDiscountCodesUpdatePayload
  }

  type Shop {
    name: String!
    primaryDomain: Domain!
    moneyFormat: String!
  }

  type Domain {
    host: String!
    url: String!
  }

  type MoneyV2 {
    """
    A decimal, as Shopify's: "2499.0".
    """
    amount: String!
    currencyCode: String!
  }

  type Image {
    id: ID
    url(transform: ImageTransformInput): String!
    altText: String
    width: Int
    height: Int
  }

  input ImageTransformInput {
    maxWidth: Int
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type ProductOption {
    id: ID!
    name: String!
    values: [String!]!
  }

  type ProductPriceRange {
    minVariantPrice: MoneyV2!
    maxVariantPrice: MoneyV2!
  }

  type SelectedOption {
    name: String!
    value: String!
  }

  input SelectedOptionInput {
    name: String!
    value: String!
  }

  type Product {
    id: ID!
    handle: String!
    title: String!
    description: String!
    descriptionHtml: String!
    vendor: String!
    productType: String!
    tags: [String!]!
    availableForSale: Boolean!
    onlineStoreUrl: String
    createdAt: String
    updatedAt: String
    options(first: Int): [ProductOption!]!
    priceRange: ProductPriceRange!
    compareAtPriceRange: ProductPriceRange!
    featuredImage: Image
    images(first: Int, after: String): ImageConnection!
    variants(first: Int, after: String): ProductVariantConnection!
    variantBySelectedOptions(selectedOptions: [SelectedOptionInput!]!): ProductVariant
  }

  type ProductVariant {
    id: ID!
    title: String!
    sku: String
    availableForSale: Boolean!
    currentlyNotInStock: Boolean!
    price: MoneyV2!
    compareAtPrice: MoneyV2
    selectedOptions: [SelectedOption!]!
    image: Image
    product: Product!
  }

  type Collection {
    id: ID!
    handle: String!
    title: String!
    description: String!
    descriptionHtml: String!
    image: Image
    onlineStoreUrl: String
    products(first: Int, after: String): ProductConnection!
  }

  type ProductEdge {
    cursor: String!
    node: Product!
  }
  type ProductConnection {
    edges: [ProductEdge!]!
    nodes: [Product!]!
    pageInfo: PageInfo!
  }
  type ProductVariantEdge {
    cursor: String!
    node: ProductVariant!
  }
  type ProductVariantConnection {
    edges: [ProductVariantEdge!]!
    nodes: [ProductVariant!]!
    pageInfo: PageInfo!
  }
  type ImageEdge {
    cursor: String!
    node: Image!
  }
  type ImageConnection {
    edges: [ImageEdge!]!
    nodes: [Image!]!
    pageInfo: PageInfo!
  }
  type CollectionEdge {
    cursor: String!
    node: Collection!
  }
  type CollectionConnection {
    edges: [CollectionEdge!]!
    nodes: [Collection!]!
    pageInfo: PageInfo!
  }

  union Merchandise = ProductVariant

  type Attribute {
    key: String!
    value: String
  }

  input AttributeInput {
    key: String!
    value: String!
  }

  type CartCost {
    subtotalAmount: MoneyV2!
    totalAmount: MoneyV2!
  }

  type CartLineCost {
    amountPerQuantity: MoneyV2!
    totalAmount: MoneyV2!
  }

  type CartLine {
    id: ID!
    quantity: Int!
    merchandise: Merchandise!
    attributes: [Attribute!]!
    cost: CartLineCost!
  }

  type BaseCartLineEdge {
    cursor: String!
    node: CartLine!
  }
  type BaseCartLineConnection {
    edges: [BaseCartLineEdge!]!
    nodes: [CartLine!]!
    pageInfo: PageInfo!
  }

  type CartDiscountCode {
    code: String!
    applicable: Boolean!
  }

  type Cart {
    id: ID!
    """
    The shop's own checkout with this cart: the shopper gives their address and pays there.
    """
    checkoutUrl: String!
    totalQuantity: Int!
    note: String
    attributes: [Attribute!]!
    discountCodes: [CartDiscountCode!]!
    lines(first: Int, after: String): BaseCartLineConnection!
    cost: CartCost!
  }

  input CartLineInput {
    merchandiseId: ID!
    quantity: Int
    attributes: [AttributeInput!]
  }

  input CartLineUpdateInput {
    id: ID!
    quantity: Int
  }

  input CartInput {
    lines: [CartLineInput!]
    note: String
    attributes: [AttributeInput!]
    discountCodes: [String!]
  }

  type CartUserError {
    field: [String!]
    message: String!
    code: String
  }

  type CartCreatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartLinesAddPayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartLinesUpdatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartLinesRemovePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartNoteUpdatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartDiscountCodesUpdatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
`;

const SCHEMA = buildSchema(SDL);

/** The Storefront API's schema, for what checks queries against it: the headless starter's (ADR-869). */
export const STOREFRONT_API_SCHEMA = SCHEMA;

/** The carts of the shop, as the core keeps them (ADR-042). */
export interface StorefrontApiCarts {
  read(shopId: string, token: string | null): Promise<CartJson | null>;
  act(
    shopId: string,
    token: string | null,
    action: string,
    body: unknown,
  ): Promise<CartActionResult>;
}

/** What a request of the Storefront API reads and changes. */
export interface StorefrontApiShop {
  shopId: string;
  store: Pick<
    StoreData,
    'products' | 'productByHandle' | 'productIds' | 'collectionByHandle' | 'handles'
  >;
  shop: Pick<ShopDoc, 'name'>;
  /** The shop's products a search finds, the likeliest first. */
  search: (terms: string) => Promise<string[]>;
  carts: StorefrontApiCarts | null;
  /** Where the shop answers: "https://zari.hatti.pk". */
  origin: string;
  currency: string;
}

/**
 * The token a request carries, checked against the shop's (ADR-848): `public` or `private` for
 * one of its own, null for none of them.
 */
export function storefrontTokenOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  tokens: readonly { digest: string; private: boolean }[] | undefined,
): 'public' | 'private' | null {
  const header = (name: string) => {
    const value = headers[name];
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  };
  for (const kind of ['private', 'public'] as const) {
    const token = header(STOREFRONT_TOKEN_HEADERS[kind]);
    if (!token) continue;
    const digest = createHash('sha256').update(token).digest('hex');
    if (
      (tokens ?? []).some((each) => each.digest === digest && each.private === (kind === 'private'))
    ) {
      return kind;
    }
  }
  return null;
}

// IDs as Shopify's are: global IDs, here Hatti's.
const gid = (type: string, id: string) => `gid://hatti/${type}/${id}`;
function idOf(type: string, value: unknown): string | null {
  const prefix = `gid://hatti/${type}/`;
  return typeof value === 'string' && value.startsWith(prefix) && value.length <= 300
    ? value.slice(prefix.length)
    : null;
}

const money = (paisa: number, currency: string) => ({
  amount: (paisa / 100).toFixed(2),
  currencyCode: currency,
});

function plainOf(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A list given a page at a time, as Shopify's connections are, by an opaque cursor. */
function connection<T>(
  items: readonly T[],
  args: { first?: number | null; after?: string | null },
) {
  const first = Math.min(Math.max(args.first ?? 20, 0), STOREFRONT_API_LIMITS.first);
  const at = args.after ? offsetOf(args.after) + 1 : 0;
  const page = items.slice(at, at + first);
  const edges = page.map((node, index) => ({ node, cursor: cursorOf(at + index) }));
  return {
    edges,
    nodes: page,
    pageInfo: {
      hasNextPage: at + first < items.length,
      hasPreviousPage: at > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

const cursorOf = (at: number) => Buffer.from(`o:${at}`).toString('base64url');
function offsetOf(cursor: string): number {
  const match = /^o:(\d{1,6})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) throw new GraphQLError('That cursor is not one this API gave');
  return Number(match[1]);
}

function imageOf(image: ImageDoc | undefined | null, origin: string) {
  if (!image) return null;
  return {
    url: (args: { transform?: { maxWidth?: number | null } | null }) =>
      imageAddress(image.src, origin, args.transform?.maxWidth ?? null),
    altText: image.alt,
    width: image.width || null,
    height: image.height || null,
  };
}

function priceRange(prices: readonly number[], currency: string) {
  const known = prices.length > 0 ? prices : [0];
  return {
    minVariantPrice: money(Math.min(...known), currency),
    maxVariantPrice: money(Math.max(...known), currency),
  };
}

function productOf(doc: ProductDoc, api: StorefrontApiShop): Record<string, unknown> {
  const variants = () => doc.variants.map((variant) => variantOf(doc, variant, api));
  return {
    id: gid('Product', doc.id),
    handle: doc.handle,
    title: doc.title,
    description: plainOf(doc.descriptionHtml),
    descriptionHtml: doc.descriptionHtml,
    vendor: doc.vendor,
    productType: doc.productType,
    tags: doc.tags,
    availableForSale: doc.variants.some((variant) => variant.available),
    onlineStoreUrl: `${api.origin}/products/${encodeURIComponent(doc.handle)}`,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    options: (args: { first?: number | null }) =>
      doc.options.slice(0, args.first ?? undefined).map((option, index) => ({
        id: gid('ProductOption', `${doc.id}-${index}`),
        name: option.name,
        values: option.values,
      })),
    priceRange: priceRange(
      doc.variants.map((variant) => variant.price),
      api.currency,
    ),
    compareAtPriceRange: priceRange(
      doc.variants.map((variant) => variant.compareAtPrice ?? variant.price),
      api.currency,
    ),
    featuredImage: imageOf(doc.images[0], api.origin),
    images: (args: { first?: number; after?: string }) =>
      connection(
        doc.images.map((image) => imageOf(image, api.origin)!),
        args,
      ),
    variants: (args: { first?: number; after?: string }) => connection(variants(), args),
    variantBySelectedOptions: (args: { selectedOptions: { name: string; value: string }[] }) => {
      const variant = doc.variants.find((each) =>
        args.selectedOptions.every((choice) => {
          const index = doc.options.findIndex((option) => option.name === choice.name);
          return index >= 0 && each.options[index] === choice.value;
        }),
      );
      return variant ? variantOf(doc, variant, api) : null;
    },
  };
}

function variantOf(doc: ProductDoc, variant: VariantDoc, api: StorefrontApiShop) {
  return {
    __typename: 'ProductVariant',
    id: gid('ProductVariant', variant.id),
    title: variant.title,
    sku: variant.sku,
    availableForSale: variant.available,
    currentlyNotInStock: !variant.available,
    price: money(variant.price, api.currency),
    compareAtPrice:
      variant.compareAtPrice !== null && variant.compareAtPrice > variant.price
        ? money(variant.compareAtPrice, api.currency)
        : null,
    selectedOptions: doc.options.map((option, index) => ({
      name: option.name,
      value: variant.options[index] ?? '',
    })),
    image: imageOf(variant.image !== null ? doc.images[variant.image] : doc.images[0], api.origin),
    product: () => productOf(doc, api),
  };
}

function collectionOf(doc: CollectionDoc, api: StorefrontApiShop) {
  return {
    id: gid('Collection', doc.id),
    handle: doc.handle,
    title: doc.title,
    description: plainOf(doc.descriptionHtml),
    descriptionHtml: doc.descriptionHtml,
    image: imageOf(doc.image, api.origin),
    onlineStoreUrl: `${api.origin}/collections/${encodeURIComponent(doc.handle)}`,
    products: (args: { first?: number; after?: string }) => productPage(doc.productIds, args, api),
  };
}

/** A page of the products `ids` name, those gone left out. */
async function productPage(
  ids: readonly string[],
  args: { first?: number | null; after?: string | null },
  api: StorefrontApiShop,
) {
  const first = Math.min(Math.max(args.first ?? 20, 0), STOREFRONT_API_LIMITS.first);
  const at = args.after ? offsetOf(args.after) + 1 : 0;
  const docs = await api.store.products(ids.slice(at, at + first));
  const edges = docs.flatMap((doc, index) =>
    doc ? [{ node: productOf(doc, api), cursor: cursorOf(at + index) }] : [],
  );
  return {
    edges,
    nodes: edges.map((edge) => edge.node),
    pageInfo: {
      hasNextPage: at + first < ids.length,
      hasPreviousPage: at > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

// Carts: their IDs carry the core's token for them, the secret a shopper's cookie keeps.
const lineIdOf = (line: CartLineJson) =>
  gid('CartLine', Buffer.from(line.key).toString('base64url'));
const lineKeyOf = (id: unknown) => {
  const encoded = idOf('CartLine', id);
  return encoded ? Buffer.from(encoded, 'base64url').toString() : null;
};

function cartOf(cart: CartJson, token: string, api: StorefrontApiShop) {
  const lines = cart.items.map((line) => ({
    id: lineIdOf(line),
    quantity: line.quantity,
    merchandise: async () => {
      const [doc] = await api.store.products([line.productId]);
      const variant = doc?.variants.find((each) => each.id === line.variantId);
      if (doc && variant) return variantOf(doc, variant, api);
      // Gone from the catalog since: what the cart knows of it.
      return {
        __typename: 'ProductVariant',
        id: gid('ProductVariant', line.variantId),
        title: line.variantTitle,
        sku: line.sku,
        availableForSale: false,
        currentlyNotInStock: true,
        price: money(line.price, api.currency),
        compareAtPrice: null,
        selectedOptions: [],
        image: null,
        product: () => {
          throw new GraphQLError('Its product is no longer sold');
        },
      };
    },
    attributes: Object.entries(line.properties).map(([key, value]) => ({ key, value })),
    cost: {
      amountPerQuantity: money(line.price, api.currency),
      totalAmount: money(line.linePrice, api.currency),
    },
  }));
  return {
    id: gid('Cart', token),
    checkoutUrl: `${api.origin}/cart/c/${encodeURIComponent(token)}`,
    totalQuantity: cart.itemCount,
    note: cart.note || null,
    attributes: Object.entries(cart.attributes).map(([key, value]) => ({ key, value })),
    discountCodes: cart.discount
      ? [{ code: cart.discount.code, applicable: cart.discount.applicable }]
      : [],
    lines: (args: { first?: number; after?: string }) => connection(lines, args),
    cost: {
      subtotalAmount: money(cart.subtotal, api.currency),
      totalAmount: money(cart.subtotal - cart.totalDiscount, api.currency),
    },
  };
}

type UserErrorJson = { field: string[] | null; message: string; code: string | null };

/** Why the core refused a cart's change, as Shopify's cart says it. */
function cartUserError(error: CartError, field: string[]): UserErrorJson {
  switch (error.code) {
    case 'NOT_FOUND':
      return { field, message: 'That merchandise is not for sale', code: 'MERCHANDISE_NOT_FOUND' };
    case 'LINE_NOT_FOUND':
      return { field, message: 'The cart has no such line', code: 'INVALID_MERCHANDISE_LINE' };
    case 'MAX_QUANTITY':
      return {
        field,
        message: `Only ${error.max} of ${error.title} can be bought now`,
        code: 'INVALID',
      };
    case 'MAX_LINES':
      return { field, message: `A cart has ${error.max} lines at most`, code: 'INVALID' };
    case 'INVALID':
      return { field, message: error.message, code: 'INVALID' };
    default:
      return { field, message: 'The cart could not be changed', code: 'INVALID' };
  }
}

const userError = (field: string[], message: string, code = 'INVALID'): UserErrorJson => ({
  field,
  message,
  code,
});

/** The variant a line names, and how many: one unless said. */
function itemOf(line: {
  merchandiseId: string;
  quantity?: number | null;
  attributes?: { key: string; value: string }[] | null;
}) {
  const variantId = idOf('ProductVariant', line.merchandiseId);
  return {
    variantId,
    quantity: line.quantity ?? 1,
    properties: Object.fromEntries((line.attributes ?? []).map((each) => [each.key, each.value])),
  };
}

function rootOf(api: StorefrontApiShop) {
  const carts = () => {
    if (!api.carts) throw new GraphQLError('This storefront keeps no carts');
    return api.carts;
  };
  /** The cart `id` names now, or why there is none. */
  const cartNamed = async (id: unknown) => {
    const token = idOf('Cart', id);
    const cart = token ? await carts().read(api.shopId, token) : null;
    return cart && token ? { cart, token } : null;
  };
  /** The cart after `action`, or why not, as a mutation's payload. */
  const changed = async (
    token: string | null,
    action: string,
    body: unknown,
    field: string[],
  ): Promise<{ cart: unknown; userErrors: UserErrorJson[]; token: string | null }> => {
    const result = await carts().act(api.shopId, token, action, body);
    if (!result.ok) return { cart: null, userErrors: [cartUserError(result.error, field)], token };
    const kept = result.token ?? token;
    return {
      cart: kept ? cartOf(result.cart, kept, api) : null,
      userErrors: [],
      token: kept,
    };
  };
  const noCart = { cart: null, userErrors: [userError(['cartId'], 'No such cart', 'INVALID')] };
  const tooMany = (field: string) => ({
    cart: null,
    userErrors: [userError([field], `${STOREFRONT_API_LIMITS.lines} lines at a time at most`)],
  });

  return {
    shop: () => ({
      name: api.shop.name,
      primaryDomain: { host: new URL(api.origin).host, url: api.origin },
      moneyFormat: 'Rs {{amount}}',
    }),
    product: async (args: { id?: string | null; handle?: string | null }) => {
      const id = args.id ? idOf('Product', args.id) : null;
      const doc = id
        ? ((await api.store.products([id]))[0] ?? null)
        : args.handle
          ? await api.store.productByHandle(args.handle)
          : null;
      return doc ? productOf(doc, api) : null;
    },
    products: async (args: { first?: number; after?: string; query?: string | null }) => {
      const terms = args.query?.trim().slice(0, 200) ?? '';
      const ids = terms ? await api.search(terms) : await api.store.productIds();
      return productPage(ids, args, api);
    },
    collection: async (args: { id?: string | null; handle?: string | null }) => {
      const handle = args.handle ?? null;
      const doc = handle ? await api.store.collectionByHandle(handle) : null;
      const wanted = args.id ? idOf('Collection', args.id) : null;
      if (wanted && !handle) {
        // By ID: among its collections, as the storefront has them by handle.
        for (const each of await api.store.handles('collection')) {
          const found = await api.store.collectionByHandle(each);
          if (found?.id === wanted) return collectionOf(found, api);
        }
        return null;
      }
      return doc ? collectionOf(doc, api) : null;
    },
    collections: async (args: { first?: number; after?: string }) => {
      const handles = await api.store.handles('collection');
      const page = connection(handles, args);
      const docs = await Promise.all(
        page.nodes.map((handle) => api.store.collectionByHandle(handle)),
      );
      const edges = page.edges.flatMap((edge, index) =>
        docs[index] ? [{ cursor: edge.cursor, node: collectionOf(docs[index]!, api) }] : [],
      );
      return { edges, nodes: edges.map((edge) => edge.node), pageInfo: page.pageInfo };
    },
    cart: async (args: { id: string }) => {
      const named = await cartNamed(args.id);
      return named ? cartOf(named.cart, named.token, api) : null;
    },

    cartCreate: async (args: {
      input?: {
        lines?: Parameters<typeof itemOf>[0][] | null;
        note?: string | null;
        attributes?: { key: string; value: string }[] | null;
        discountCodes?: string[] | null;
      } | null;
    }) => {
      const input = args.input ?? {};
      const lines = input.lines ?? [];
      if (lines.length > STOREFRONT_API_LIMITS.lines) return tooMany('input.lines');
      const items = lines.map(itemOf);
      if (items.some((item) => !item.variantId)) {
        return {
          cart: null,
          userErrors: [userError(['input', 'lines'], 'Each merchandiseId is a ProductVariant ID')],
        };
      }
      // A cart needs a line to be: made by its first change.
      let result = await changed(
        null,
        'add',
        { items: items.map((item) => ({ ...item, variantId: item.variantId! })) },
        ['input', 'lines'],
      );
      if (result.userErrors.length > 0 || !result.token) {
        return {
          cart: result.cart,
          userErrors:
            result.userErrors.length > 0
              ? result.userErrors
              : [userError(['input', 'lines'], 'A cart starts with a line')],
        };
      }
      const update: Record<string, unknown> = {};
      if (input.note !== null && input.note !== undefined) update.note = input.note;
      if (input.attributes) {
        update.attributes = Object.fromEntries(
          input.attributes.map((each) => [each.key, each.value]),
        );
      }
      if (input.discountCodes) update.discount = input.discountCodes.join(',');
      if (Object.keys(update).length > 0) {
        result = await changed(result.token, 'update', update, ['input']);
      }
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartLinesAdd: async (args: { cartId: string; lines: Parameters<typeof itemOf>[0][] }) => {
      if (args.lines.length > STOREFRONT_API_LIMITS.lines) return tooMany('lines');
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const items = args.lines.map(itemOf);
      if (items.some((item) => !item.variantId)) {
        return {
          cart: null,
          userErrors: [userError(['lines'], 'Each merchandiseId is a ProductVariant ID')],
        };
      }
      const result = await changed(
        named.token,
        'add',
        { items: items.map((item) => ({ ...item, variantId: item.variantId! })) },
        ['lines'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartLinesUpdate: async (args: {
      cartId: string;
      lines: { id: string; quantity?: number | null }[];
    }) => {
      if (args.lines.length > STOREFRONT_API_LIMITS.lines) return tooMany('lines');
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const updates = args.lines.map((line) => ({
        key: lineKeyOf(line.id),
        quantity: line.quantity ?? 1,
      }));
      if (updates.some((update) => !update.key)) {
        return {
          cart: null,
          userErrors: [
            userError(['lines'], 'Each id is a CartLine ID', 'INVALID_MERCHANDISE_LINE'),
          ],
        };
      }
      const result = await changed(
        named.token,
        'update',
        {
          updates: updates.map((update) => ({
            line: { key: update.key! },
            quantity: update.quantity,
          })),
        },
        ['lines'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartLinesRemove: async (args: { cartId: string; lineIds: string[] }) => {
      if (args.lineIds.length > STOREFRONT_API_LIMITS.lines) return tooMany('lineIds');
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const keys = args.lineIds.map(lineKeyOf);
      if (keys.some((key) => !key)) {
        return {
          cart: null,
          userErrors: [
            userError(['lineIds'], 'Each id is a CartLine ID', 'INVALID_MERCHANDISE_LINE'),
          ],
        };
      }
      const result = await changed(
        named.token,
        'update',
        { updates: keys.map((key) => ({ line: { key: key! }, quantity: 0 })) },
        ['lineIds'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartNoteUpdate: async (args: { cartId: string; note: string }) => {
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const result = await changed(named.token, 'update', { note: args.note }, ['note']);
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartDiscountCodesUpdate: async (args: { cartId: string; discountCodes?: string[] | null }) => {
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const result = await changed(
        named.token,
        'update',
        { discount: (args.discountCodes ?? []).join(',') },
        ['discountCodes'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
  };
}

/** How deep a query's selections go, its fragments followed. */
function depthOf(document: DocumentNode): number {
  const fragments = new Map(
    document.definitions.flatMap((definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION ? [[definition.name.value, definition]] : [],
    ),
  );
  const visit = (set: SelectionSetNode | undefined, depth: number, seen: Set<string>): number => {
    if (!set || depth > STOREFRONT_API_LIMITS.depth) return depth;
    let deepest = depth;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        deepest = Math.max(deepest, visit(selection.selectionSet, depth + 1, seen));
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, visit(selection.selectionSet, depth, seen));
      } else {
        const name = selection.name.value;
        if (seen.has(name)) continue;
        deepest = Math.max(
          deepest,
          visit(fragments.get(name)?.selectionSet, depth, new Set([...seen, name])),
        );
      }
    }
    return deepest;
  };
  return Math.max(
    0,
    ...document.definitions.map((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION
        ? visit(definition.selectionSet, 0, new Set())
        : 0,
    ),
  );
}

/** A GraphQL request's answer, as its body is JSON. */
export async function storefrontApiAnswer(
  body: unknown,
  api: StorefrontApiShop,
): Promise<ExecutionResult> {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const query = request.query;
  if (typeof query !== 'string' || query.length === 0) {
    return { errors: [new GraphQLError('Give the query')] };
  }
  if (query.length > STOREFRONT_API_LIMITS.query) {
    return {
      errors: [new GraphQLError(`A query is ${STOREFRONT_API_LIMITS.query} characters at most`)],
    };
  }
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (error) {
    return { errors: [error as GraphQLError] };
  }
  const invalid = validate(SCHEMA, document);
  if (invalid.length > 0) return { errors: invalid };
  if (depthOf(document) > STOREFRONT_API_LIMITS.depth) {
    return {
      errors: [new GraphQLError(`A query asks ${STOREFRONT_API_LIMITS.depth} fields deep at most`)],
    };
  }
  const variables =
    typeof request.variables === 'object' && request.variables !== null
      ? (request.variables as Record<string, unknown>)
      : undefined;
  return execute({
    schema: SCHEMA,
    document,
    rootValue: rootOf(api),
    variableValues: variables,
    operationName: typeof request.operationName === 'string' ? request.operationName : undefined,
  });
}
