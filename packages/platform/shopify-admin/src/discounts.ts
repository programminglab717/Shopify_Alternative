import type { ShopifyAdmin, ShopifyResult } from './admin.js';

/** Products, variants' products or collections a discount is for, as Shopify's queries take them. */
const ITEMS = `
  ... on AllDiscountItems { allItems }
  ... on DiscountProducts {
    products(first: 25) { nodes { handle } }
    productVariants(first: 25) { nodes { product { handle } } }
  }
  ... on DiscountCollections { collections(first: 25) { nodes { handle } } }`;

const COMMON = `title status startsAt endsAt usageLimit asyncUsageCount appliesOncePerCustomer
  codesCount { count }
  codes(first: 20) { nodes { code } }`;

const MINIMUM = `minimumRequirement {
  ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
  ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
}`;

/**
 * A page of a store's discount codes: five at a time, which keeps a query's cost within what
 * Shopify takes, its codes, items and minimums nested in kinds a bulk query cannot hold.
 */
export const DISCOUNT_CODES_QUERY = `query DiscountCodes($after: String) {
  codeDiscountNodes(first: 5, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          ${COMMON}
          ${MINIMUM}
          customerGets {
            value {
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount } appliesOnEachItem }
            }
            items { ${ITEMS} }
          }
        }
        ... on DiscountCodeFreeShipping {
          ${COMMON}
          ${MINIMUM}
        }
        ... on DiscountCodeBxgy {
          ${COMMON}
          customerBuys {
            value {
              ... on DiscountQuantity { quantity }
              ... on DiscountPurchaseAmount { amount }
            }
            items { ${ITEMS} }
          }
          customerGets {
            value {
              ... on DiscountOnQuantity {
                quantity { quantity }
                effect { ... on DiscountPercentage { percentage } }
              }
            }
            items { ${ITEMS} }
          }
        }
        ... on DiscountCodeApp { ${COMMON} }
      }
    }
  }
}`;

const SHOP = `{ shop { name currencyCode } }`;

/** The most pages read: 1,000 discounts, far more than a shop keeps. */
const MAX_PAGES = 200;

/** What a discount is for: all items, products by handle, or collections by handle. */
export type StoreDiscountItems =
  { all: true } | { products: string[] } | { collections: string[] } | null;

/** A store's discount, with up to 20 of its codes, as Shopify has it. */
export interface StoreDiscount {
  title: string;
  /** Shopify's: DiscountCodeBasic, DiscountCodeFreeShipping, DiscountCodeBxgy or DiscountCodeApp. */
  kind: string;
  /** ACTIVE, SCHEDULED or EXPIRED. */
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  /** Times it was used at Shopify. */
  used: number;
  oncePerCustomer: boolean;
  codes: string[];
  /** All its codes, of which `codes` are the first. */
  codesCount: number;
  /** A fraction, 0.1 for 10 per cent; for buy X get Y, off what is given. */
  percentage: number | null;
  /** An amount off, in the store's currency's major units. */
  amount: string | null;
  /** Whether the amount comes off each item, rather than the order. */
  amountOnEachItem: boolean;
  minimumSubtotal: string | null;
  minimumQuantity: number | null;
  /** What it takes off; for buy X get Y, what is given. */
  items: StoreDiscountItems;
  /** Buy X get Y: what is bought, and how many; or the amount to buy, which a quantity is not. */
  buyItems: StoreDiscountItems;
  buyQuantity: number | null;
  buyAmount: string | null;
  getQuantity: number | null;
}

/** A store's discount codes, read through its Admin API. */
export interface StoreDiscounts {
  storeName: string;
  /** The currency its amounts are in, ISO 4217. */
  currency: string;
  discounts: StoreDiscount[];
}

type Json = Record<string, unknown> | null | undefined;

interface DiscountsPage {
  codeDiscountNodes: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { codeDiscount: Json }[];
  };
}

const number = (value: unknown): number | null =>
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const handles = (connection: unknown, of: (node: Json) => unknown): string[] =>
  (((connection as Json)?.nodes as Json[] | undefined) ?? [])
    .map((node) => text(of(node)))
    .filter((handle): handle is string => handle !== null);

function itemsOf(items: Json): StoreDiscountItems {
  if (!items) return null;
  if (items.allItems === true) return { all: true };
  if (items.collections) {
    return { collections: handles(items.collections, (node) => node?.handle) };
  }
  if (items.products || items.productVariants) {
    const products = [
      ...handles(items.products, (node) => node?.handle),
      ...handles(items.productVariants, (node) => (node?.product as Json)?.handle),
    ];
    return { products: [...new Set(products)] };
  }
  return null;
}

/** A discount as the query gives it, made plain. */
function discountOf(node: Json): StoreDiscount {
  const minimum = node?.minimumRequirement as Json;
  const gets = node?.customerGets as Json;
  const buys = node?.customerBuys as Json;
  const value = gets?.value as Json;
  const effect = value?.effect as Json;
  const buyValue = buys?.value as Json;
  return {
    title: String(node?.title ?? ''),
    kind: String(node?.__typename ?? ''),
    status: String(node?.status ?? 'ACTIVE'),
    startsAt: text(node?.startsAt),
    endsAt: text(node?.endsAt),
    usageLimit: number(node?.usageLimit),
    used: number(node?.asyncUsageCount) ?? 0,
    oncePerCustomer: node?.appliesOncePerCustomer === true,
    codes: handles(node?.codes, (code) => code?.code),
    codesCount: number((node?.codesCount as Json)?.count) ?? 0,
    percentage: number(value?.percentage ?? effect?.percentage),
    amount: text((value?.amount as Json)?.amount),
    amountOnEachItem: value?.appliesOnEachItem === true,
    minimumSubtotal: text((minimum?.greaterThanOrEqualToSubtotal as Json)?.amount),
    minimumQuantity: number(minimum?.greaterThanOrEqualToQuantity),
    items: itemsOf(gets?.items as Json),
    buyItems: buys ? itemsOf(buys.items as Json) : null,
    buyQuantity: number(buyValue?.quantity),
    buyAmount: text(buyValue?.amount),
    getQuantity: number((value?.quantity as Json)?.quantity),
  };
}

/**
 * A store's discount codes through its Admin API (ONB-05, ADR-756): the store asked first, which
 * proves the credentials and says the currency its amounts are in, then its discounts five at a
 * time. The app needs the read_discounts scope.
 */
export async function readStoreDiscounts(
  admin: ShopifyAdmin,
): Promise<ShopifyResult<StoreDiscounts>> {
  const shop = await admin.graphql<{ shop: { name: string; currencyCode: string } }>(SHOP);
  if (!shop.ok) return shop;
  const discounts: StoreDiscount[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const read: ShopifyResult<DiscountsPage> = await admin.graphql<DiscountsPage>(
      DISCOUNT_CODES_QUERY,
      { after },
    );
    if (!read.ok) {
      return read.kind === 'scope'
        ? {
            ...read,
            message:
              "The store's app may not read its discounts: give it the read_discounts access scope",
          }
        : read;
    }
    const { pageInfo, nodes }: DiscountsPage['codeDiscountNodes'] = read.value.codeDiscountNodes;
    for (const node of nodes) discounts.push(discountOf(node.codeDiscount));
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return {
    ok: true,
    value: { storeName: shop.value.shop.name, currency: shop.value.shop.currencyCode, discounts },
  };
}
