import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/**
 * A store's customers, as Shopify's bulk queries take them: each with its email address and phone
 * number and their marketing consent, its default address's phone, note and tags; and its
 * addresses, on lines of their own (ADR-784).
 */
export const CUSTOMERS_BULK_QUERY = `{
  customers {
    edges {
      node {
        id firstName lastName note tags
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber { phoneNumber marketingState }
        defaultAddress { id phone }
        addressesV2 {
          edges {
            node { id firstName lastName phone address1 address2 city province zip countryCodeV2 }
          }
        }
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
  /** Its addresses (ADR-784), its default first. */
  addresses: StoreAddress[];
}

/** A customer's address at a store, as Shopify has it. */
export interface StoreAddress {
  /** Its own first and last names; null for neither. */
  name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  /** The province's name, as Punjab. */
  province: string | null;
  zip: string | null;
  /** ISO 3166's two letters, as PK; null where Shopify gives none. */
  countryCode: string | null;
  /** Whether it is the customer's default. */
  isDefault: boolean;
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
  // Each customer taken, by its ID, with its default address's, for its addresses' lines.
  const byId = new Map<string, { customer: StoreCustomer; defaultAddress: string | null }>();
  let withoutPhone = 0;
  try {
    for (const line of jsonLines(file.value)) {
      const id = String(line.id ?? '');
      if (id.startsWith('gid://shopify/MailingAddress/')) {
        const owner = typeof line.__parentId === 'string' ? byId.get(line.__parentId) : undefined;
        if (!owner) continue;
        const names = [text(line.firstName), text(line.lastName)].filter(Boolean).join(' ');
        const address: StoreAddress = {
          name: names || null,
          phone: text(line.phone),
          address1: text(line.address1),
          address2: text(line.address2),
          city: text(line.city),
          province: text(line.province),
          zip: text(line.zip),
          countryCode: text(line.countryCodeV2),
          isDefault: owner.defaultAddress !== null && sameAddress(id, owner.defaultAddress),
        };
        if (address.isDefault) owner.customer.addresses.unshift(address);
        else owner.customer.addresses.push(address);
        continue;
      }
      if (!id.startsWith('gid://shopify/Customer/')) continue;
      const email = line.defaultEmailAddress as
        { emailAddress?: unknown; marketingState?: unknown } | null | undefined;
      const phone = line.defaultPhoneNumber as
        { phoneNumber?: unknown; marketingState?: unknown } | null | undefined;
      const address = line.defaultAddress as { id?: unknown; phone?: unknown } | null | undefined;
      const number = text(phone?.phoneNumber) ?? text(address?.phone);
      if (!number) {
        withoutPhone++;
        continue;
      }
      const customer: StoreCustomer = {
        firstName: text(line.firstName),
        lastName: text(line.lastName),
        email: text(email?.emailAddress),
        phone: number,
        emailMarketing: text(email?.marketingState),
        smsMarketing: text(phone?.marketingState),
        note: text(line.note),
        tags: Array.isArray(line.tags) ? line.tags.map(String) : [],
        addresses: [],
      };
      customers.push(customer);
      byId.set(id, { customer, defaultAddress: text(address?.id) });
    }
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return { ok: true, value: { storeName: shop.value.shop.name, customers, withoutPhone } };
}

/**
 * Whether Shopify's IDs `a` and `b` name one address: its addresses' IDs may carry a query, as
 * gid://shopify/MailingAddress/1?model_name=CustomerAddress, which one may have and the other not.
 */
function sameAddress(a: string, b: string): boolean {
  return a.split('?')[0] === b.split('?')[0];
}
