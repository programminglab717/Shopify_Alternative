import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/**
 * A store's orders, as Shopify's bulk queries take them (ADR-786): each with its customer's number,
 * where it went, its amounts in the store's currency and how it was paid and sent; its items on
 * lines of their own.
 */
export const ORDERS_BULK_QUERY = `{
  orders {
    edges {
      node {
        id name createdAt cancelledAt currencyCode email phone note
        displayFinancialStatus displayFulfillmentStatus
        customer { defaultPhoneNumber { phoneNumber } }
        shippingAddress { name phone address1 address2 city province zip countryCodeV2 }
        subtotalPriceSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
        lineItems {
          edges {
            node { id title variantTitle sku quantity originalUnitPriceSet { shopMoney { amount } } }
          }
        }
      }
    }
  }
}`;

const SHOP = `{ shop { name } }`;

/** An item of a store's order; `price` each, in hundredths of the order's currency. */
export interface StoreOrderLine {
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  price: bigint;
}

/** Where a store's order went. */
export interface StoreOrderAddress {
  name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  countryCode: string | null;
}

/** A store's order, as Shopify has it; amounts in hundredths of its currency. */
export interface StoreOrder {
  /** Shopify's ID, as gid://shopify/Order/1. */
  id: string;
  /** As #1001. */
  name: string;
  /** The order's own number, else its customer's, else where it went's. */
  phone: string | null;
  email: string | null;
  placedAt: string;
  cancelledAt: string | null;
  /** ISO 4217: the store's. */
  currency: string;
  subtotal: bigint;
  shipping: bigint;
  discounts: bigint;
  total: bigint;
  /** As PAID or PARTIALLY_REFUNDED. */
  financialStatus: string | null;
  /** As FULFILLED or UNFULFILLED. */
  fulfillmentStatus: string | null;
  note: string;
  shippingAddress: StoreOrderAddress | null;
  lines: StoreOrderLine[];
}

/** A store's orders, read through its Admin API. */
export interface StoreOrders {
  /** The store's name, as Shopify has it. */
  storeName: string;
  /** The store's orders, in the order Shopify gives them. */
  orders: StoreOrder[];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * A decimal amount as Shopify writes one, "4500.0", in hundredths: 450000. Zero for none, or one
 * that does not read.
 */
export function hundredthsOf(value: unknown): bigint {
  const match = typeof value === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim()) : null;
  if (!match) return 0n;
  const [, sign, whole, fraction = ''] = match;
  const hundredths = BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
  return sign === '-' ? -hundredths : hundredths;
}

/** The shop money of one of Shopify's MoneyBags, in hundredths. */
const shopMoney = (bag: unknown): bigint =>
  hundredthsOf((bag as { shopMoney?: { amount?: unknown } } | null | undefined)?.shopMoney?.amount);

/**
 * A store's orders through its Admin API (ONB-05, ADR-786): the store asked first, which proves
 * the credentials, then every order in one bulk query. The app needs the read_orders scope, and
 * read_all_orders for those over 60 days old, and Shopify's leave to read customers' names,
 * emails, phones and addresses.
 */
export async function readStoreOrders(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StoreOrders>> {
  const shop = await admin.graphql<{ shop: { name: string } }>(SHOP);
  if (!shop.ok) return shop;
  const file = await runBulkQuery(admin, ORDERS_BULK_QUERY, options);
  if (!file.ok) {
    return file.kind === 'scope'
      ? {
          ...file,
          message:
            "The store's app may not read its orders: give it the read_orders access scope, " +
            'read_all_orders for those over 60 days old, and in its settings the access to ' +
            "customers' names, emails, phones and addresses",
        }
      : file;
  }
  const orders = new Map<string, StoreOrder>();
  try {
    for (const line of jsonLines(file.value)) {
      const id = String(line.id ?? '');
      if (id.startsWith('gid://shopify/LineItem/')) {
        const order = typeof line.__parentId === 'string' ? orders.get(line.__parentId) : undefined;
        if (!order) continue;
        order.lines.push({
          title: text(line.title) ?? '',
          variantTitle: text(line.variantTitle),
          sku: text(line.sku),
          quantity: typeof line.quantity === 'number' ? line.quantity : 0,
          price: shopMoney(line.originalUnitPriceSet),
        });
        continue;
      }
      if (!id.startsWith('gid://shopify/Order/')) continue;
      const customer = line.customer as
        { defaultPhoneNumber?: { phoneNumber?: unknown } | null } | null | undefined;
      const address = line.shippingAddress as Record<string, unknown> | null | undefined;
      const shippingAddress: StoreOrderAddress | null = address
        ? {
            name: text(address.name),
            phone: text(address.phone),
            address1: text(address.address1),
            address2: text(address.address2),
            city: text(address.city),
            province: text(address.province),
            zip: text(address.zip),
            countryCode: text(address.countryCodeV2),
          }
        : null;
      orders.set(id, {
        id,
        name: text(line.name) ?? id,
        phone:
          text(line.phone) ??
          text(customer?.defaultPhoneNumber?.phoneNumber) ??
          shippingAddress?.phone ??
          null,
        email: text(line.email),
        placedAt: String(line.createdAt),
        cancelledAt: text(line.cancelledAt),
        currency: text(line.currencyCode) ?? 'PKR',
        subtotal: shopMoney(line.subtotalPriceSet),
        shipping: shopMoney(line.totalShippingPriceSet),
        discounts: shopMoney(line.totalDiscountsSet),
        total: shopMoney(line.totalPriceSet),
        financialStatus: text(line.displayFinancialStatus),
        fulfillmentStatus: text(line.displayFulfillmentStatus),
        note: text(line.note) ?? '',
        shippingAddress,
        lines: [],
      });
    }
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return { ok: true, value: { storeName: shop.value.shop.name, orders: [...orders.values()] } };
}
