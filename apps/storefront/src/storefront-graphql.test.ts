import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, validate } from 'graphql';
import type { CartActionResult, CartJson } from '@hatti/storefront-api';
import { MemoryStore, TranslatedStore } from '@hatti/storefront-data';
import { describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import {
  STOREFRONT_API_LIMITS,
  STOREFRONT_API_SCHEMA,
  storefrontApiAnswer,
  storefrontTokenOf,
  type StorefrontApiShop,
} from './storefront-graphql.js';

const sample = sampleStore();
const lawn = sample.products.find(
  (product) =>
    product.variants.length > 1 && product.variants[0]!.available && product.variants[1]!.available,
)!;
const [first, second] = lawn.variants as [(typeof lawn.variants)[0], (typeof lawn.variants)[0]];

/** Carts as the core keeps them, by token, each line priced from the sample. */
class Carts {
  readonly kept = new Map<string, CartJson>();
  readonly acted: { token: string | null; action: string; body: unknown }[] = [];
  #next = 1;

  read(_shopId: string, token: string | null) {
    return Promise.resolve(token ? (this.kept.get(token) ?? null) : null);
  }

  act(
    _shopId: string,
    token: string | null,
    action: string,
    body: unknown,
  ): Promise<CartActionResult> {
    this.acted.push({ token, action, body });
    const kept = token ? this.kept.get(token) : undefined;
    const cart: CartJson = kept
      ? structuredClone(kept)
      : {
          note: '',
          attributes: {},
          items: [],
          itemCount: 0,
          subtotal: 0,
          totalWeightGrams: 0,
          discount: null,
          totalDiscount: 0,
        };
    const named = token && kept ? token : `cart-${this.#next++}`;
    if (action === 'add') {
      for (const item of (body as { items: { variantId: string; quantity: number }[] }).items) {
        const variant = lawn.variants.find((each) => each.id === item.variantId);
        if (!variant) {
          return Promise.resolve({
            ok: false,
            error: { code: 'NOT_FOUND', variantId: item.variantId },
          });
        }
        cart.items.unshift({
          key: `${variant.id}:k`,
          variantId: variant.id,
          productId: lawn.id,
          quantity: item.quantity,
          properties: {},
          price: variant.price,
          linePrice: variant.price * item.quantity,
          title: lawn.title,
          variantTitle: variant.title,
          sku: variant.sku,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        });
      }
    } else if (action === 'update') {
      const update = body as {
        updates?: { line: { key: string }; quantity: number }[];
        note?: string;
        discount?: string;
      };
      for (const each of update.updates ?? []) {
        const line = cart.items.find((item) => item.key === each.line.key);
        if (!line) return Promise.resolve({ ok: false, error: { code: 'LINE_NOT_FOUND' } });
        line.quantity = each.quantity;
        line.linePrice = line.price * each.quantity;
      }
      cart.items = cart.items.filter((item) => item.quantity > 0);
      if (update.note !== undefined) cart.note = update.note;
      if (update.discount) {
        cart.discount = {
          code: update.discount,
          applicable: true,
          kind: 'fixed_amount',
          value: 100,
          amount: 100,
        };
        cart.totalDiscount = 100;
      }
    }
    cart.itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.subtotal = cart.items.reduce((sum, item) => sum + item.linePrice, 0);
    this.kept.set(named, cart);
    return Promise.resolve({ ok: true, cart, token: named, added: [] });
  }
}

function api(carts = new Carts()): StorefrontApiShop & { carts: Carts } {
  return {
    shopId: 'shop',
    store: new MemoryStore(sample),
    shop: { name: 'Zari' },
    search: () => Promise.resolve([lawn.id]),
    carts,
    origin: 'https://zari.hatti.pk',
    currency: 'PKR',
  };
}

// Answers are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function ask(query: string, variables?: Record<string, unknown>, at = api()) {
  return (await storefrontApiAnswer({ query, variables }, at)) as {
    data?: Json;
    errors?: { message: string }[];
  };
}

describe('The Storefront API (DEV-02, ADR-848)', () => {
  it("answers only to the shop's own tokens, public in one header and private in another", () => {
    const digest = (token: string) => createHash('sha256').update(token).digest('hex');
    const tokens = [
      { digest: digest('hsf_public'), private: false },
      { digest: digest('hsfp_private'), private: true },
    ];
    expect(storefrontTokenOf({ 'x-shopify-storefront-access-token': 'hsf_public' }, tokens)).toBe(
      'public',
    );
    expect(storefrontTokenOf({ 'shopify-storefront-private-token': 'hsfp_private' }, tokens)).toBe(
      'private',
    );
    // A private token sent as a public one, or a token the shop hasn't: none.
    expect(storefrontTokenOf({ 'x-shopify-storefront-access-token': 'hsfp_private' }, tokens)).toBe(
      null,
    );
    expect(storefrontTokenOf({ 'x-shopify-storefront-access-token': 'other' }, tokens)).toBe(null);
    expect(storefrontTokenOf({}, undefined)).toBe(null);
  });

  it('gives the shop, its products and collections as Shopify does, a page at a time', async () => {
    const { data } = await ask(`{
      shop { name primaryDomain { host url } }
      products(first: 2) {
        nodes { id handle }
        pageInfo { hasNextPage endCursor }
      }
    }`);
    expect(data.shop).toEqual({
      name: 'Zari',
      primaryDomain: { host: 'zari.hatti.pk', url: 'https://zari.hatti.pk' },
    });
    expect(data.products.nodes).toHaveLength(2);
    expect(data.products.pageInfo.hasNextPage).toBe(true);
    const next = await ask(
      `query ($after: String) { products(first: 2, after: $after) { nodes { id } } }`,
      {
        after: data.products.pageInfo.endCursor,
      },
    );
    expect(next.data.products.nodes[0].id).not.toBe(data.products.nodes[0].id);

    const product = await ask(
      `query ($handle: String) {
        product(handle: $handle) {
          id title availableForSale onlineStoreUrl
          priceRange { minVariantPrice { amount currencyCode } }
          options { name values }
          featuredImage { url(transform: { maxWidth: 400 }) }
          variants(first: 5) { nodes { id title price { amount } selectedOptions { name value } } }
          variantBySelectedOptions(selectedOptions: [{ name: "${lawn.options[0]!.name}", value: "${first.options[0]}" }]) { id }
        }
      }`,
      { handle: lawn.handle },
    );
    expect(product.errors).toBeUndefined();
    expect(product.data.product).toMatchObject({
      id: `gid://hatti/Product/${lawn.id}`,
      title: lawn.title,
      availableForSale: true,
      onlineStoreUrl: `https://zari.hatti.pk/products/${lawn.handle}`,
      priceRange: {
        minVariantPrice: {
          amount: (Math.min(...lawn.variants.map((v) => v.price)) / 100).toFixed(2),
          currencyCode: 'PKR',
        },
      },
    });
    expect(product.data.product.variants.nodes[0]).toMatchObject({
      id: `gid://hatti/ProductVariant/${first.id}`,
      price: { amount: (first.price / 100).toFixed(2) },
    });
    expect(product.data.product.variantBySelectedOptions).not.toBeNull();
    // By its ID too.
    const byId = await ask(`{ product(id: "gid://hatti/Product/${lawn.id}") { handle } }`);
    expect(byId.data.product.handle).toBe(lawn.handle);
    expect((await ask(`{ product(handle: "nothing") { id } }`)).data.product).toBeNull();

    const collection = sample.collections[0]!;
    const collections = await ask(`{
      collections(first: 1) { nodes { handle } }
      collection(handle: "${collection.handle}") { title products(first: 1) { nodes { id } } }
    }`);
    expect(collections.errors).toBeUndefined();
    expect(collections.data.collection.title).toBe(collection.title);
  });

  it('searches through the core where a query is given', async () => {
    const { data } = await ask(`{ products(first: 5, query: "lawn") { nodes { id } } }`);
    expect(data.products.nodes).toEqual([{ id: `gid://hatti/Product/${lawn.id}` }]);
  });

  it("makes and changes carts through the core, checked out at the shop's own checkout", async () => {
    const at = api();
    const LINES = `lines(first: 10) { nodes { id quantity merchandise { ... on ProductVariant { id title product { handle } } } cost { totalAmount { amount } } } }`;
    const made = await ask(
      `mutation ($input: CartInput) {
        cartCreate(input: $input) {
          cart { id checkoutUrl totalQuantity note discountCodes { code applicable } cost { subtotalAmount { amount } totalAmount { amount } } ${LINES} }
          userErrors { field message code }
        }
      }`,
      {
        input: {
          lines: [{ merchandiseId: `gid://hatti/ProductVariant/${first.id}`, quantity: 2 }],
          note: 'Gift wrap it',
          discountCodes: ['EID100'],
        },
      },
      at,
    );
    expect(made.errors).toBeUndefined();
    const cart = made.data.cartCreate.cart;
    expect(made.data.cartCreate.userErrors).toEqual([]);
    expect(cart).toMatchObject({
      id: 'gid://hatti/Cart/cart-1',
      checkoutUrl: 'https://zari.hatti.pk/cart/c/cart-1',
      totalQuantity: 2,
      note: 'Gift wrap it',
      discountCodes: [{ code: 'EID100', applicable: true }],
      cost: {
        subtotalAmount: { amount: ((first.price * 2) / 100).toFixed(2) },
        totalAmount: { amount: ((first.price * 2 - 100) / 100).toFixed(2) },
      },
    });
    expect(cart.lines.nodes[0].merchandise).toMatchObject({
      id: `gid://hatti/ProductVariant/${first.id}`,
      product: { handle: lawn.handle },
    });
    expect(at.carts.acted.map((each) => each.action)).toEqual(['add', 'update']);

    const added = await ask(
      `mutation { cartLinesAdd(cartId: "${cart.id}", lines: [{ merchandiseId: "gid://hatti/ProductVariant/${second.id}" }]) { cart { totalQuantity ${LINES} } userErrors { code } } }`,
      undefined,
      at,
    );
    expect(added.data.cartLinesAdd.cart.totalQuantity).toBe(3);
    const lineId = cart.lines.nodes[0].id;
    const updated = await ask(
      `mutation { cartLinesUpdate(cartId: "${cart.id}", lines: [{ id: "${lineId}", quantity: 5 }]) { cart { totalQuantity } userErrors { code } } }`,
      undefined,
      at,
    );
    expect(updated.data.cartLinesUpdate.cart.totalQuantity).toBe(6);
    const removed = await ask(
      `mutation { cartLinesRemove(cartId: "${cart.id}", lineIds: ["${lineId}"]) { cart { totalQuantity } } }`,
      undefined,
      at,
    );
    expect(removed.data.cartLinesRemove.cart.totalQuantity).toBe(1);
    const read = await ask(`{ cart(id: "${cart.id}") { totalQuantity } }`, undefined, at);
    expect(read.data.cart.totalQuantity).toBe(1);

    // Refused as Shopify's cart refuses: a variant not sold, a cart not made, a line not in it.
    const unknown = await ask(
      `mutation { cartLinesAdd(cartId: "${cart.id}", lines: [{ merchandiseId: "gid://hatti/ProductVariant/nothing" }]) { cart { id } userErrors { code } } }`,
      undefined,
      at,
    );
    expect(unknown.data.cartLinesAdd.userErrors).toEqual([{ code: 'MERCHANDISE_NOT_FOUND' }]);
    const none = await ask(
      `mutation { cartNoteUpdate(cartId: "gid://hatti/Cart/gone", note: "x") { cart { id } userErrors { field } } }`,
      undefined,
      at,
    );
    expect(none.data.cartNoteUpdate.userErrors).toEqual([{ field: ['cartId'] }]);
    expect(
      (await ask(`{ cart(id: "gid://hatti/Cart/gone") { id } }`, undefined, at)).data.cart,
    ).toBeNull();
    const wrong = await ask(
      `mutation { cartLinesUpdate(cartId: "${cart.id}", lines: [{ id: "gid://hatti/CartLine/bm9wZQ", quantity: 1 }]) { userErrors { code } } }`,
      undefined,
      at,
    );
    expect(wrong.data.cartLinesUpdate.userErrors).toEqual([{ code: 'INVALID_MERCHANDISE_LINE' }]);
  });

  it('refuses queries too long, too deep, or not of its schema', async () => {
    expect((await ask('{ nothing }')).errors?.[0]?.message).toContain('Cannot query field');
    expect((await ask('x'.repeat(STOREFRONT_API_LIMITS.query + 1))).errors?.[0]?.message).toContain(
      'characters at most',
    );
    const deep = `{ products(first: 1) { nodes { variants(first: 1) { nodes { product { variants(first: 1) { nodes { product { variants(first: 1) { nodes { product { variants(first: 1) { nodes { title } } } } } } } } } } } } } }`;
    expect((await ask(deep)).errors?.[0]?.message).toContain('deep at most');
    expect((await storefrontApiAnswer({}, api())).errors?.[0]?.message).toBe('Give the query');
  });
});

// The headless starter (OS-19, ADR-869) lives outside the workspace, as a project of its own to
// copy; what it asks the Storefront API is checked here, so it keeps working as the API changes.
const STARTER_QUERIES = fileURLToPath(
  new URL('../../../starters/next-storefront/lib/queries.ts', import.meta.url),
);

/** Each query the starter's queries file holds, by its constant's name. */
function starterQueries(): Record<string, string> {
  const source = readFileSync(STARTER_QUERIES, 'utf8');
  const found: Record<string, string> = {};
  for (const match of source.matchAll(/export const (\w+) = \/\* GraphQL \*\/ `([^`]*)`/g)) {
    found[match[1]!] = match[2]!;
  }
  return found;
}

describe('The headless starter on the Storefront API (OS-19, ADR-869)', () => {
  it('asks only what the Storefront API answers, whole', () => {
    const queries = starterQueries();
    expect(Object.keys(queries).sort()).toEqual([
      'CART_CREATE_MUTATION',
      'CART_LINES_ADD_MUTATION',
      'CART_LINES_REMOVE_MUTATION',
      'CART_LINES_UPDATE_MUTATION',
      'CART_QUERY',
      'COLLECTION_QUERY',
      'PRODUCTS_QUERY',
      'PRODUCT_QUERY',
      'SHOP_QUERY',
    ]);
    for (const [name, query] of Object.entries(queries)) {
      expect(query, name).not.toContain('${');
      expect(
        validate(STOREFRONT_API_SCHEMA, parse(query)).map((error) => error.message),
        name,
      ).toEqual([]);
    }
  });

  it('browses the shop, and keeps a cart to its checkout, as the starter does', async () => {
    const q = starterQueries();
    const at = api();
    expect((await ask(q.SHOP_QUERY!, {}, at)).data.shop.name).toBe('Zari');
    const listed = (await ask(q.PRODUCTS_QUERY!, { first: 24, after: null, query: null }, at)).data
      .products;
    expect(listed.nodes.length).toBeGreaterThan(0);
    expect(listed.nodes[0].priceRange.minVariantPrice.currencyCode).toBe('PKR');
    const product = (await ask(q.PRODUCT_QUERY!, { handle: lawn.handle }, at)).data.product;
    expect(product.title).toBe(lawn.title);
    const variant = product.variants.nodes[0].id as string;

    const made = (
      await ask(q.CART_CREATE_MUTATION!, { lines: [{ merchandiseId: variant, quantity: 2 }] }, at)
    ).data.cartCreate;
    expect(made.userErrors).toEqual([]);
    const cart = (await ask(q.CART_QUERY!, { id: made.cart.id }, at)).data.cart;
    expect(cart.totalQuantity).toBe(2);
    expect(cart.checkoutUrl).toMatch(/^https:\/\/zari\.hatti\.pk\//);
    expect(cart.lines.nodes[0].merchandise.product.handle).toBe(lawn.handle);

    const line = cart.lines.nodes[0].id as string;
    await ask(
      q.CART_LINES_UPDATE_MUTATION!,
      { cartId: made.cart.id, lines: [{ id: line, quantity: 3 }] },
      at,
    );
    expect((await ask(q.CART_QUERY!, { id: made.cart.id }, at)).data.cart.totalQuantity).toBe(3);
    await ask(q.CART_LINES_REMOVE_MUTATION!, { cartId: made.cart.id, lineIds: [line] }, at);
    expect((await ask(q.CART_QUERY!, { id: made.cart.id }, at)).data.cart.totalQuantity).toBe(0);
  });
});

describe("The Storefront API's menus, pages, blogs and policies (ADR-890)", () => {
  const withPolicies = () => {
    const store = new MemoryStore({
      ...sample,
      policies: { privacy_policy: '<p>We keep your number to deliver your order.</p>' },
    });
    return { ...api(), store, shop: { name: 'Zari', policies: ['privacy_policy'] } };
  };

  it('gives a menu by its handle, its links made absolute and typed', async () => {
    const { data } = await ask(`{
      menu(handle: "footer") { handle title itemsCount items { title url type items { title } } }
      none: menu(handle: "nowhere") { handle }
    }`);
    expect(data.none).toBeNull();
    expect(data.menu).toMatchObject({ handle: 'footer', title: 'Footer', itemsCount: 3 });
    expect(data.menu.items[0]).toEqual({
      title: 'Returns and exchanges',
      url: 'https://zari.hatti.pk/pages/returns',
      type: 'PAGE',
      items: [],
    });
  });

  it('gives pages by handle, by ID and a page at a time', async () => {
    const { data } = await ask(`{
      page(handle: "returns") { id handle title body bodySummary onlineStoreUrl }
      pages(first: 2) { nodes { handle } pageInfo { hasNextPage endCursor } }
    }`);
    expect(data.page).toMatchObject({
      handle: 'returns',
      title: 'Returns and exchanges',
      onlineStoreUrl: 'https://zari.hatti.pk/pages/returns',
    });
    expect(data.page.body).toContain('<strong>7 days</strong>');
    expect(data.page.bodySummary).toMatch(/^Changed your mind\? Send it back within 7 days/);
    const byId = await ask('query ($id: ID!) { page(id: $id) { handle } }', { id: data.page.id });
    expect(byId.data.page).toEqual({ handle: 'returns' });
    const handles = sample.pages!.map((page) => page.handle).sort();
    expect(data.pages.nodes.map((each: Json) => each.handle)).toEqual(handles.slice(0, 2));
    expect(data.pages.pageInfo.hasNextPage).toBe(handles.length > 2);
  });

  it("gives a blog's articles, the latest first, and an article by its handle", async () => {
    const { data } = await ask(`{
      blog(handle: "news") {
        handle title onlineStoreUrl
        articles(first: 5) { nodes { handle title excerpt authorV2 { name } blog { handle } } }
        articleByHandle(handle: "eid-lawn-is-here") { title content onlineStoreUrl }
      }
      blogs(first: 5) { nodes { handle } }
      articles(first: 10) { nodes { handle } }
    }`);
    expect(data.blog).toMatchObject({
      handle: 'news',
      title: 'News',
      onlineStoreUrl: 'https://zari.hatti.pk/blogs/news',
    });
    expect(data.blog.articles.nodes.map((each: Json) => each.handle)).toEqual(
      sample.articles!.map((article) => article.handle),
    );
    expect(data.blog.articles.nodes[0]).toMatchObject({
      title: 'Eid lawn is here',
      excerpt: 'Hand-block printed in Multan, out now.',
      blog: { handle: 'news' },
    });
    expect(data.blog.articleByHandle).toMatchObject({
      title: 'Eid lawn is here',
      onlineStoreUrl: 'https://zari.hatti.pk/blogs/news/eid-lawn-is-here',
    });
    expect(data.blog.articleByHandle.content).toMatch(/^Our Eid lawn is hand-block printed/);
    expect(data.blogs.nodes).toEqual([{ handle: 'news' }]);
    expect(data.articles.nodes).toHaveLength(sample.articles!.length);
  });

  it('gives the policies the shop has, null for the rest', async () => {
    const { data } = await ask(
      '{ shop { privacyPolicy { handle title body url } refundPolicy { handle } } }',
      undefined,
      withPolicies(),
    );
    expect(data.shop).toEqual({
      privacyPolicy: {
        handle: 'privacy-policy',
        title: 'Privacy policy',
        body: '<p>We keep your number to deliver your order.</p>',
        url: 'https://zari.hatti.pk/policies/privacy-policy',
      },
      refundPolicy: null,
    });
  });
});

describe('The Storefront API in Urdu, and its metafields (ADR-903)', () => {
  const store = new MemoryStore({
    ...sample,
    products: sample.products.map((product) =>
      product.id === lawn.id
        ? {
            ...product,
            translations: { ur: { title: 'لان سوٹ' } },
            metafields: { custom: { fabric: { type: 'single_line_text_field', value: 'Lawn' } } },
            variants: product.variants.map((variant, index) =>
              index === 0
                ? {
                    ...variant,
                    metafields: { custom: { pieces: { type: 'number_integer', value: '3' } } },
                  }
                : variant,
            ),
          }
        : product,
    ),
  });
  const urdu = (): ReturnType<typeof api> => ({
    ...api(),
    store,
    inLanguage: (locale) => new TranslatedStore(store, locale),
  });
  const PRODUCT = `product(handle: "${lawn.handle}") { title onlineStoreUrl }`;

  it('answers in Urdu where a query asks for it, its pages at their Urdu addresses', async () => {
    const asked = await ask(
      `query Shop($language: LanguageCode) @inContext(language: $language, country: AE) {
        localization { language { isoCode endonymName } availableLanguages { isoCode } country { isoCode } }
        ${PRODUCT}
      }`,
      { language: 'UR' },
      urdu(),
    );
    expect(asked.errors).toBeUndefined();
    expect(asked.data).toEqual({
      localization: {
        language: { isoCode: 'UR', endonymName: 'اردو' },
        availableLanguages: [{ isoCode: 'EN' }, { isoCode: 'UR' }],
        country: { isoCode: 'AE' },
      },
      product: {
        title: 'لان سوٹ',
        onlineStoreUrl: `https://zari.hatti.pk/ur/products/${lawn.handle}`,
      },
    });
    // In English, or a language the shop's storefront has not, its own words.
    for (const language of ['EN', 'AR']) {
      const own = await ask(
        `query @inContext(language: ${language}) { ${PRODUCT} }`,
        undefined,
        urdu(),
      );
      expect(own.data.product).toEqual({
        title: lawn.title,
        onlineStoreUrl: `https://zari.hatti.pk/products/${lawn.handle}`,
      });
    }
    const plain = await ask(`{ localization { language { isoCode } country { isoCode } } }`);
    expect(plain.data.localization).toEqual({
      language: { isoCode: 'EN' },
      country: { isoCode: 'PK' },
    });
  });

  it('gives the metafields the shop shows, by namespace and key, null for those it has not', async () => {
    const { data, errors } = await ask(
      `{
        product(handle: "${lawn.handle}") {
          fabric: metafield(key: "fabric") { namespace key type value }
          missing: metafield(namespace: "custom", key: "care") { value }
          metafields(identifiers: [{ namespace: "custom", key: "fabric" }, { namespace: "other", key: "x" }]) { key }
          variants(first: 1) { edges { node { metafield(key: "pieces") { type value } } } }
        }
      }`,
      undefined,
      urdu(),
    );
    expect(errors).toBeUndefined();
    expect(data.product).toEqual({
      fabric: { namespace: 'custom', key: 'fabric', type: 'single_line_text_field', value: 'Lawn' },
      missing: null,
      metafields: [{ key: 'fabric' }, null],
      variants: { edges: [{ node: { metafield: { type: 'number_integer', value: '3' } } }] },
    });
  });
});
