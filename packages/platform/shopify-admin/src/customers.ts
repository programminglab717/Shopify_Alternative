import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/**
 * A store's customers, as Shopify's bulk queries take them: each with its email address and phone
 * number and their marketing consent, its default address's phone, note and tags.
 */
export const CUSTOMERS_BULK_QUERY = `{
  customers {
    edges {
      node {
        id firstName lastName note tags
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber { phoneNumber marketingState }
        defaultAddress { phone }
      }
    }
  }
}`;

const SHOP = `{ shop { name } }`;

/** A store's customer, as Shopify has it. */
export interface StoreCustomer {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** Its own number, or its default address's where it has none. */
  phone: string;
  /** Shopify's marketing states, as SUBSCRIBED or UNSUBSCRIBED; null where it has no address. */
  emailMarketing: string | null;
  smsMarketing: string | null;
  note: string | null;
  tags: string[];
}

/** A store's customers, read through its Admin API. */
export interface StoreCustomers {
  /** The store's name, as Shopify has it. */
  storeName: string;
  /** Those with a phone number, the store's order. */
  customers: StoreCustomer[];
  /** Those with none, which a shop that finds its customers by their numbers cannot take. */
  withoutPhone: number;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Shopify's marketing state as its customer export writes it: yes, unsubscribed, or blank. */
function consent(state: string | null): string {
  if (state === 'SUBSCRIBED') return 'yes';
  if (state === 'UNSUBSCRIBED') return 'unsubscribed';
  return '';
}

/**
 * Customers as Shopify's customer export writes them, the headings the customer import reads,
 * and the name, email or number of the customer on each row, for its row errors.
 */
export function storeCustomersCsv(customers: readonly StoreCustomer[]): {
  csv: string;
  rowNames: string[];
} {
  const quoted = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  const rows = [
    [
      'First Name',
      'Last Name',
      'Email',
      'Accepts Email Marketing',
      'Phone',
      'Accepts SMS Marketing',
      'Note',
      'Tags',
    ],
    ...customers.map((customer) => [
      customer.firstName ?? '',
      customer.lastName ?? '',
      customer.email ?? '',
      consent(customer.emailMarketing),
      customer.phone,
      consent(customer.smsMarketing),
      customer.note ?? '',
      customer.tags.join(', '),
    ]),
  ];
  return {
    csv: rows.map((row) => row.map(quoted).join(',')).join('\r\n') + '\r\n',
    rowNames: customers.map(
      (customer) =>
        [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
        customer.email ||
        customer.phone,
    ),
  };
}

/**
 * A store's customers through its Admin API (ONB-05, ADR-755): the store asked first, which
 * proves the credentials, then every customer in one bulk query. The app needs the
 * read_customers scope, and Shopify's leave to read their names, emails, phones and addresses.
 */
export async function readStoreCustomers(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StoreCustomers>> {
  const shop = await admin.graphql<{ shop: { name: string } }>(SHOP);
  if (!shop.ok) return shop;
  const file = await runBulkQuery(admin, CUSTOMERS_BULK_QUERY, options);
  if (!file.ok) {
    return file.kind === 'scope'
      ? {
          ...file,
          message:
            "The store's app may not read its customers: give it the read_customers access " +
            "scope, and in its settings the access to customers' names, emails, phones and " +
            'addresses',
        }
      : file;
  }
  const customers: StoreCustomer[] = [];
  let withoutPhone = 0;
  try {
    for (const line of jsonLines(file.value)) {
      if (!String(line.id ?? '').startsWith('gid://shopify/Customer/')) continue;
      const email = line.defaultEmailAddress as
        { emailAddress?: unknown; marketingState?: unknown } | null | undefined;
      const phone = line.defaultPhoneNumber as
        { phoneNumber?: unknown; marketingState?: unknown } | null | undefined;
      const address = line.defaultAddress as { phone?: unknown } | null | undefined;
      const number = text(phone?.phoneNumber) ?? text(address?.phone);
      if (!number) {
        withoutPhone++;
        continue;
      }
      customers.push({
        firstName: text(line.firstName),
        lastName: text(line.lastName),
        email: text(email?.emailAddress),
        phone: number,
        emailMarketing: text(email?.marketingState),
        smsMarketing: text(phone?.marketingState),
        note: text(line.note),
        tags: Array.isArray(line.tags) ? line.tags.map(String) : [],
      });
    }
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return { ok: true, value: { storeName: shop.value.shop.name, customers, withoutPhone } };
}
